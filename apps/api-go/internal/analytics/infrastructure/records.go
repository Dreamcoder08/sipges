// Package infrastructure reads the analytics inputs from PostgreSQL with the queries of
// apps/api/src/contexts/analytics/infrastructure (sql-analytics-record-reader.ts and
// sql-dashboard-record-reader.ts), inside the tenant transaction (docs/adr/0003), and the
// tenant's label with the query of the tenancy store.
package infrastructure

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analytics/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// ErrUnsecured refuses a records table without forced row-level security rather than trust it.
var ErrUnsecured = errors.New("Analytics requires forced tenant row-level security") //nolint:staticcheck // the TypeScript API's message

// relation tells whether public.module_records exists and forces row-level security.
const relation = `SELECT to_regclass('public.module_records')::text AS present,
  COALESCE((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
    WHERE oid = to_regclass('public.module_records')), false) AS secured`

// recordsQuery reads complete payloads, newest first as app.py lists them.
const recordsQuery = `SELECT module, id, payload FROM public.module_records
  WHERE tenant_id = $1 AND module = ANY($2::text[]) ORDER BY updated_at DESC, id`

// dashboardQuery keeps only the fields the dashboard counts, as JSON values (not ->> text):
// Python truthiness and coercion belong to the counters. Missing keys become null, equivalent
// for the status and level fallbacks. RLS still evaluates the original row, marking included.
const dashboardQuery = `SELECT module, id,
    CASE module
      WHEN 'Demandas' THEN jsonb_build_object('Estado', payload->'Estado')
      WHEN 'Alertas' THEN jsonb_build_object(
        'Estado', payload->'Estado',
        'Nivel_Preliminar', payload->'Nivel_Preliminar', 'Nivel', payload->'Nivel')
      ELSE '{}'::jsonb
    END AS payload
  FROM public.module_records
  WHERE tenant_id = $1 AND module = ANY($2::text[]) ORDER BY updated_at DESC, id`

// Records reads public.module_records (owned by the records context) under the tenant's RLS
// transaction. Until that table exists every module reads as empty.
type Records struct {
	DB database.Beginner
}

// Read returns the requested modules' records with their complete payloads.
func (r Records) Read(ctx context.Context, tenantID string, modules []string) (domain.RecordsByModule, error) {
	return r.read(ctx, tenantID, modules, recordsQuery)
}

// ReadDashboard returns the requested modules' records with the dashboard's fields only.
func (r Records) ReadDashboard(ctx context.Context, tenantID string, modules []string) (domain.RecordsByModule, error) {
	return r.read(ctx, tenantID, modules, dashboardQuery)
}

func (r Records) read(ctx context.Context, tenantID string, modules []string, query string) (domain.RecordsByModule, error) {
	result := domain.EmptyRecords(modules)
	if len(modules) == 0 {
		return result, nil
	}
	return database.WithTenant(ctx, r.DB, tenantID, func(ctx context.Context, q database.Querier) (domain.RecordsByModule, error) {
		var (
			present *string
			secured bool
		)
		if err := q.QueryRow(ctx, relation).Scan(&present, &secured); err != nil {
			return nil, err
		}
		if present == nil {
			return result, nil
		}
		if !secured {
			return nil, ErrUnsecured
		}
		rows, err := q.Query(ctx, query, tenantID, modules)
		if err != nil {
			return nil, err
		}
		type row struct {
			module string
			record domain.StoredRecord
		}
		found, err := pgx.CollectRows(rows, func(cr pgx.CollectableRow) (row, error) {
			var (
				out     row
				payload []byte
			)
			err := cr.Scan(&out.module, &out.record.ID, &payload)
			out.record.Payload = payload
			return out, err
		})
		if err != nil {
			return nil, err
		}
		for _, f := range found {
			result.Add(f.module, f.record)
		}
		return result, nil
	})
}

// Querier is the part of a pgx pool the label lookup uses.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Labels is sql-tenancy-store.ts tenantLabel: the global tenants table, outside row-level
// security, as Tenancy's label(scope) reads it.
type Labels struct{ DB Querier }

// Label returns the tenant's display label, or nil when the tenant does not exist.
func (l Labels) Label(ctx context.Context, scope tenancy.Scope) (*string, error) {
	var label string
	err := l.DB.QueryRow(ctx, `SELECT label FROM tenants WHERE company_id = $1 AND project_id = $2`,
		scope.CompanyID, scope.ProjectID).Scan(&label)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &label, nil
}

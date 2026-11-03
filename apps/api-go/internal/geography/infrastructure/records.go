package infrastructure

import (
	"context"
	"errors"
	"fmt"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// ErrUnsecuredRecords refuses a module_records table without forced row-level security.
var ErrUnsecuredRecords = errors.New("analytics requires forced tenant row-level security")

// ReadRecords is createSqlAnalyticsRecordReader
// (apps/api/src/contexts/analytics/infrastructure/sql-analytics-record-reader.ts) inside a
// tenant transaction q: the tenant's module_records of modules, newest first, grouped in the
// order modules lists them. Until the table exists every module reads as empty; a table without
// forced row-level security is refused rather than trusted.
func ReadRecords(ctx context.Context, q database.Querier, tenantID string, modules []string) ([]application.ModuleRecords, error) {
	out := make([]application.ModuleRecords, len(modules))
	index := make(map[string]int, len(modules))
	for i, m := range modules {
		out[i] = application.ModuleRecords{Module: m}
		if _, seen := index[m]; !seen {
			index[m] = i
		}
	}
	if len(modules) == 0 {
		return out, nil
	}
	var present *string
	var secured bool
	if err := q.QueryRow(ctx, `SELECT to_regclass('public.module_records')::text AS present,
	    COALESCE((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
	      WHERE oid = to_regclass('public.module_records')), false) AS secured`).Scan(&present, &secured); err != nil {
		return nil, err
	}
	if present == nil || *present == "" {
		return out, nil
	}
	if !secured {
		return nil, ErrUnsecuredRecords
	}
	rows, err := q.Query(ctx, `SELECT module, id, payload FROM public.module_records
	    WHERE tenant_id = $1 AND module = ANY($2::text[]) ORDER BY updated_at DESC, id`, tenantID, modules)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var module, id string
		var payload []byte
		if err := rows.Scan(&module, &id, &payload); err != nil {
			return nil, err
		}
		v, err := domain.DecodeJSON(payload)
		if err != nil {
			return nil, fmt.Errorf("record %s/%s payload: %w", module, id, err)
		}
		m, _ := v.(map[string]any) // a non-object payload has none of the fields read
		if m == nil {
			m = map[string]any{}
		}
		if i, ok := index[module]; ok {
			out[i].Records = append(out[i].Records, application.Record{ID: id, Payload: m})
		}
	}
	return out, rows.Err()
}

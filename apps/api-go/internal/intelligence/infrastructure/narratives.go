package infrastructure

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// ErrUnsecured refuses a records table without forced row-level security rather than trust it.
var ErrUnsecured = errors.New("Analytics requires forced tenant row-level security") //nolint:staticcheck // the TypeScript API's message

// relation tells whether public.module_records exists and forces row-level security, as
// sql-analytics-record-reader.ts checks before reading it.
const relation = `SELECT to_regclass('public.module_records')::text AS present,
  COALESCE((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
    WHERE oid = to_regclass('public.module_records')), false) AS secured`

// narrativesQuery is the record reader's query for the narratives module: complete payloads,
// newest first as app.py lists them.
const narrativesQuery = `SELECT payload FROM public.module_records
  WHERE tenant_id = $1 AND module = ANY($2::text[]) ORDER BY updated_at DESC, id`

// Narratives reads the payloads of the tenant's narrative records (owned by the records
// context) under the tenant's RLS transaction, as compose.ts hands them to the intelligence
// service. Until that table exists there are none.
type Narratives struct {
	DB database.Beginner
}

// Narratives returns the payloads, newest first; never nil.
func (n Narratives) Narratives(ctx context.Context, tenantID string) ([]json.RawMessage, error) {
	return database.WithTenant(ctx, n.DB, tenantID, func(ctx context.Context, q database.Querier) ([]json.RawMessage, error) {
		var (
			present *string
			secured bool
		)
		if err := q.QueryRow(ctx, relation).Scan(&present, &secured); err != nil {
			return nil, err
		}
		if present == nil {
			return []json.RawMessage{}, nil
		}
		if !secured {
			return nil, ErrUnsecured
		}
		rows, err := q.Query(ctx, narrativesQuery, tenantID, []string{"Narrativas"}) //nolint:misspell // the Spanish module name
		if err != nil {
			return nil, err
		}
		payloads, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (json.RawMessage, error) {
			var payload []byte
			err := row.Scan(&payload)
			return json.RawMessage(payload), err
		})
		if payloads == nil {
			payloads = []json.RawMessage{}
		}
		return payloads, err
	})
}

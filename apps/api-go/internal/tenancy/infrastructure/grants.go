// Package infrastructure reads the tenancy tables (global, outside row-level security).
package infrastructure

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// Querier is the part of a pgx pool the grant lookup uses.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// Grants is sql-tenancy-store.ts listGrants.
type Grants struct{ DB Querier }

// List returns the user's grants ordered by company and project, as the TypeScript store does.
func (g Grants) List(ctx context.Context, username string) ([]domain.Grant, error) {
	rows, err := g.DB.Query(ctx,
		`SELECT t.company_id, t.project_id, t.label
		   FROM grants g JOIN tenants t ON t.tenant_id = g.tenant_id
		  WHERE g.username = $1::text
		  ORDER BY t.company_id, t.project_id`, username)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Grant, error) {
		var gr domain.Grant
		err := row.Scan(&gr.CompanyID, &gr.ProjectID, &gr.Label)
		return gr, err
	})
}

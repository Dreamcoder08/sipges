// Package infrastructure holds the PostgreSQL adapters of the tenancy context.
package infrastructure

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// Querier is the part of a pgx pool the store uses; it must be the base role's pool
// (sipges_tenant cannot read grants or tenants).
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// GrantStore reads grants as sql-tenancy-store.ts listGrants does.
type GrantStore struct{ DB Querier }

const listGrants = `SELECT t.company_id, t.project_id
  FROM grants g JOIN tenants t ON t.tenant_id = g.tenant_id
 WHERE g.username = $1::text
 ORDER BY t.company_id, t.project_id`

// ListGrants implements application.GrantStore.
func (s GrantStore) ListGrants(ctx context.Context, username string) ([]domain.Scope, error) {
	rows, err := s.DB.Query(ctx, listGrants, username)
	if err != nil {
		return nil, fmt.Errorf("list grants: %w", err)
	}
	grants, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Scope, error) {
		var s domain.Scope
		return s, row.Scan(&s.CompanyID, &s.ProjectID)
	})
	if err != nil {
		return nil, fmt.Errorf("list grants: %w", err)
	}
	return grants, nil
}

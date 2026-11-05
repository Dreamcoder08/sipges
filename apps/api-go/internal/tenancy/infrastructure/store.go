package infrastructure

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// DB is what the store runs on: the pool, as the owner role (tenants, grants and users are
// global tables outside row-level security).
type DB interface {
	database.Querier
	database.Beginner
}

// Store is the write half of sql-tenancy-store.ts, statement for statement.
type Store struct {
	DB DB
	Grants
}

// NewStore builds the store on db.
func NewStore(db DB) Store { return Store{DB: db, Grants: Grants{DB: db}} }

// ListGrants is listGrants.
func (s Store) ListGrants(ctx context.Context, username string) ([]domain.Grant, error) {
	return s.List(ctx, username)
}

// CreateTenantWithGrant is createTenantWithGrant: the tenant and its first grant in one
// transaction; false, with nothing written, when the tenant exists.
func (s Store) CreateTenantWithGrant(ctx context.Context, t domain.NewTenant, at time.Time) (bool, error) {
	created := false
	err := pgx.BeginFunc(ctx, s.DB, func(tx pgx.Tx) error {
		var tenantID string
		err := tx.QueryRow(ctx,
			`INSERT INTO tenants (company_id, project_id, label, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING tenant_id`,
			t.CompanyID, t.ProjectID, t.Label, at).Scan(&tenantID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO grants (username, tenant_id, created_at) VALUES ($1, $2, $3)`,
			t.Username, t.TenantID(), at); err != nil {
			return err
		}
		created = true
		return nil
	})
	if err != nil {
		return false, err
	}
	return created, nil
}

// TenantExists is tenantExists.
func (s Store) TenantExists(ctx context.Context, sc domain.Scope) (bool, error) {
	return exists(ctx, s.DB, `SELECT 1 FROM tenants WHERE company_id = $1 AND project_id = $2`, sc.CompanyID, sc.ProjectID)
}

// Grant is grant: idempotent.
func (s Store) Grant(ctx context.Context, username string, sc domain.Scope, at time.Time) error {
	_, err := s.DB.Exec(ctx,
		`INSERT INTO grants (username, tenant_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		username, sc.TenantID(), at)
	return err
}

// Revoke is revoke: deletes exactly one grant; false when it was already absent.
func (s Store) Revoke(ctx context.Context, username string, sc domain.Scope) (bool, error) {
	rows, err := s.DB.Query(ctx, `DELETE FROM grants WHERE username = $1 AND tenant_id = $2 RETURNING username`,
		username, sc.TenantID())
	if err != nil {
		return false, err
	}
	deleted, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return false, err
	}
	return len(deleted) == 1, nil
}

// Users is the account lookup Tenancy needs from Identity (UserDirectory.exists through
// identity.userExists, which reads the row whatever its active flag).
type Users struct{ DB database.Querier }

// Exists is userExists: SELECT … FROM users WHERE username = $1 found a row.
func (u Users) Exists(ctx context.Context, username string) (bool, error) {
	return exists(ctx, u.DB, `SELECT 1 FROM users WHERE username = $1`, username)
}

func exists(ctx context.Context, db database.Querier, sql string, args ...any) (bool, error) {
	var one int
	err := db.QueryRow(ctx, sql, args...).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

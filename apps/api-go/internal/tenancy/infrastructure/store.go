package infrastructure

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/audittrail"
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

// RenameTenant is renameTenant: the new label and its audit row commit together. The tenant
// row is locked and updated first, as the owner; entering the project then drops to the role
// that can append only to that project's audit trail. False, with nothing written, when the
// project does not exist.
func (s Store) RenameTenant(ctx context.Context, sc domain.Scope, label, by string, at time.Time) (bool, error) {
	renamed := false
	err := pgx.BeginFunc(ctx, s.DB, func(tx pgx.Tx) error {
		var tenantID, previous string
		err := tx.QueryRow(ctx,
			`SELECT tenant_id, label FROM tenants WHERE company_id = $1 AND project_id = $2 FOR UPDATE`,
			sc.CompanyID, sc.ProjectID).Scan(&tenantID, &previous)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("lock tenant: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE tenants SET label = $1 WHERE tenant_id = $2`, label, tenantID); err != nil {
			return fmt.Errorf("rename tenant: %w", err)
		}
		if err := database.EnterTenant(ctx, tx, tenantID); err != nil {
			return fmt.Errorf("enter tenant: %w", err)
		}
		if err := audittrail.Append(ctx, tx, audittrail.Entry{
			At: at, Module: domain.RenameAuditModule, RecordID: audittrail.ID(tenantID),
			Action: domain.RenameAuditAction, Detail: domain.RenameDetail(previous, label, by),
		}); err != nil {
			return fmt.Errorf("append audit: %w", err)
		}
		renamed = true
		return nil
	})
	if err != nil {
		return false, err
	}
	return renamed, nil
}

// EnsureTenant is ensureTenant: an existing project keeps its label.
func (s Store) EnsureTenant(ctx context.Context, sc domain.Scope, label string, at time.Time) error {
	_, err := s.DB.Exec(ctx,
		`INSERT INTO tenants (company_id, project_id, label, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
		sc.CompanyID, sc.ProjectID, label, at)
	return err
}

// GrantDefaultToAdmins is the loop of tenancy.bootstrap in one statement: every administrator
// reaches the default project.
func (s Store) GrantDefaultToAdmins(ctx context.Context, at time.Time) error {
	_, err := s.DB.Exec(ctx,
		`INSERT INTO grants (username, tenant_id, created_at)
		 SELECT username, $1, $2 FROM users WHERE role = 'admin' ON CONFLICT DO NOTHING`,
		domain.DefaultScope.TenantID(), at)
	return err
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

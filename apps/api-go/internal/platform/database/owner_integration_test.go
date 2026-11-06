package database_test

import (
	"context"
	"os"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// The superusers of the synthetic servers never reach forced row-level security: PostgreSQL
// skips RLS for them, and sipges_tenant, which WithTenant drops to, is not the tables' owner. So
// here the owner is a login like production's, and it must see nothing outside a tenant.

// notForced are the tables with a tenant_id and no forced RLS. tenants, grants and api_keys are
// global directories. automation_cursors stays unforced on purpose: the schedulers list tenants
// from it as the owner, before entering any of them, and FORCE would hide every row.
var notForced = []string{"api_keys", "automation_cursors", "grants", "tenants"}

func ownedScratch(t *testing.T) *dbtest.Scratch {
	t.Helper()
	adminURL := os.Getenv(dbtest.EnvAdminURL)
	if adminURL == "" {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	s, err := dbtest.NewOwnedScratch(t.Context(), adminURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Drop(context.Background()) })
	return s
}

func TestEveryTenantTableForcesRowLevelSecurityOnItsOwner(t *testing.T) {
	s := ownedScratch(t)
	ctx := t.Context()
	owner, err := pgx.Connect(ctx, s.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = owner.Close(context.Background()) }()

	rows, err := owner.Query(ctx, `SELECT c.relname FROM pg_class c
		JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
		WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
		  AND NOT (c.relrowsecurity AND c.relforcerowsecurity) ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	tables, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(tables, notForced) {
		t.Fatalf("tables without forced RLS: %v, want %v", tables, notForced)
	}

	admin, err := pgx.Connect(ctx, s.AdminURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(context.Background()) }()
	if _, err := admin.Exec(ctx, `
		INSERT INTO tenants (company_id, project_id, label) VALUES ('EXP', 'UNO', 'Uno');
		INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking)
		VALUES ('EXP/UNO', 'Eventos', 'r1', '{}', now(), now(), 'interno');
		INSERT INTO automation_cursors (tenant_id, last_audit_id) VALUES ('EXP/UNO', 0);`); err != nil {
		t.Fatal(err)
	}
	count := func(table string) int {
		var n int
		if err := owner.QueryRow(ctx, `SELECT count(*) FROM `+table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := count("module_records"); n != 0 {
		t.Fatalf("the owner read %d rows outside any tenant", n)
	}
	// What the schedulers depend on: dueTenants, activeTenants and cursorTenants read this way.
	if n := count("automation_cursors"); n != 1 {
		t.Fatalf("the owner listed %d cursors", n)
	}
}

func TestAnOwnerWithoutPrivilegesServes(t *testing.T) {
	s := ownedScratch(t)
	pool, err := database.OpenForServing(t.Context(), s.URL, false)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tenant, err := database.WithTenant(t.Context(), pool, "EXP/UNO", func(ctx context.Context, q database.Querier) (string, error) {
		var role string
		return role, q.QueryRow(ctx, "SELECT current_user").Scan(&role)
	})
	if err != nil || tenant != "sipges_tenant" {
		t.Fatalf("role %q, err %v", tenant, err)
	}
}

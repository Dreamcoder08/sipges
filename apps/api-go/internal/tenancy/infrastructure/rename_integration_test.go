package infrastructure_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/infrastructure"
)

func renameDatabase(t *testing.T) *pgxpool.Pool {
	t.Helper()
	adminURL := os.Getenv(dbtest.EnvAdminURL)
	if adminURL == "" {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	s, err := dbtest.NewScratch(t.Context(), adminURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Drop(context.Background()) })
	pool, err := pgxpool.New(t.Context(), s.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO tenants (company_id, project_id, label) VALUES
		  ('SIPGES', 'PRJ-SECHURA', 'Proyecto principal'), ('ACME', 'ALFARROBO', 'Alfarrobo');`); err != nil {
		t.Fatal(err)
	}
	return pool
}

type auditRow struct{ Module, RecordID, Action, Detail string }

// auditOf reads one project's trail as that project, through row-level security.
func auditOf(t *testing.T, pool *pgxpool.Pool, tenantID string) []auditRow {
	t.Helper()
	var rows []auditRow
	err := pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
		if err := database.EnterTenant(t.Context(), tx, tenantID); err != nil {
			return err
		}
		r, err := tx.Query(t.Context(), `SELECT module, record_id, action, detail FROM audit ORDER BY id`)
		if err != nil {
			return err
		}
		rows, err = pgx.CollectRows(r, func(row pgx.CollectableRow) (auditRow, error) {
			var a auditRow
			return a, row.Scan(&a.Module, &a.RecordID, &a.Action, &a.Detail)
		})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

func labelOf(t *testing.T, pool *pgxpool.Pool, tenantID string) string {
	t.Helper()
	var label string
	if err := pool.QueryRow(t.Context(), `SELECT label FROM tenants WHERE tenant_id = $1`, tenantID).Scan(&label); err != nil {
		t.Fatal(err)
	}
	return label
}

func TestRenameTenantStoresTheLabelAndAuditsItInThatProjectOnly(t *testing.T) {
	pool := renameDatabase(t)
	store := infrastructure.NewStore(pool)
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

	renamed, err := store.RenameTenant(t.Context(), domain.DefaultScope, "Proyecto Sechura", "admin", at)
	if err != nil || !renamed {
		t.Fatalf("renamed %v, err %v", renamed, err)
	}
	if got := labelOf(t, pool, "SIPGES/PRJ-SECHURA"); got != "Proyecto Sechura" {
		t.Fatalf("label %q", got)
	}
	if got := labelOf(t, pool, "ACME/ALFARROBO"); got != "Alfarrobo" {
		t.Fatalf("the other project's label changed to %q", got)
	}
	want := auditRow{"Proyectos", "SIPGES/PRJ-SECHURA", "RENAME", "Proyecto renombrado de «Proyecto principal» a «Proyecto Sechura» por admin"}
	if got := auditOf(t, pool, "SIPGES/PRJ-SECHURA"); len(got) != 1 || got[0] != want {
		t.Fatalf("audit %+v, want %+v", got, want)
	}
	if got := auditOf(t, pool, "ACME/ALFARROBO"); len(got) != 0 {
		t.Fatalf("the other project's trail got %+v", got)
	}
}

func TestRenameTenantOfAMissingProjectWritesNothing(t *testing.T) {
	pool := renameDatabase(t)
	renamed, err := infrastructure.NewStore(pool).RenameTenant(t.Context(),
		domain.Scope{CompanyID: "NO", ProjectID: "PE"}, "Nuevo", "admin", time.Now())
	if err != nil || renamed {
		t.Fatalf("renamed %v, err %v", renamed, err)
	}
	if got := auditOf(t, pool, "NO/PE"); len(got) != 0 {
		t.Fatalf("audit %+v", got)
	}
}

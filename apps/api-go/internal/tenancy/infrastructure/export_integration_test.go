package infrastructure_test

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/infrastructure"
)

var exportScope = domain.Scope{CompanyID: "EXP", ProjectID: "UNO"}

// exportDatabase is a scratch database of this test alone: it changes table definitions.
func exportDatabase(t *testing.T) *pgxpool.Pool {
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
		INSERT INTO tenants (company_id, project_id, label) VALUES ('EXP', 'UNO', 'Uno'), ('EXP', 'DOS', 'Dos');
		INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking) VALUES
		  ('EXP/UNO', 'Eventos', 'r1', '{}', now(), now(), 'restringido'),
		  ('EXP/DOS', 'Eventos', 'r2', '{}', now(), now(), 'interno');`); err != nil {
		t.Fatal(err)
	}
	return pool
}

func TestExportRefusesATableWithoutForcedRowLevelSecurity(t *testing.T) {
	pool := exportDatabase(t)
	if _, err := pool.Exec(t.Context(), `ALTER TABLE notifications NO FORCE ROW LEVEL SECURITY`); err != nil {
		t.Fatal(err)
	}
	_, err := infrastructure.ExportData{DB: pool}.Read(t.Context(), exportScope)
	if err == nil || !strings.Contains(err.Error(), "Export requires forced tenant row-level security") {
		t.Fatalf("got %v", err)
	}
}

func TestExportSkipsATableOfAnOlderSchema(t *testing.T) {
	pool := exportDatabase(t)
	if _, err := pool.Exec(t.Context(), `DROP TABLE preventive_action_log`); err != nil {
		t.Fatal(err)
	}
	data, err := infrastructure.ExportData{DB: pool}.Read(t.Context(), exportScope)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := data.Get("preventive_action_log"); !ok || string(records.Stringify(got)) != "[]" {
		t.Fatalf("got %v, %v", got, ok)
	}
}

func TestExportSurvivesAMigrationOfAnExportedTable(t *testing.T) {
	pool := exportDatabase(t)
	reader := infrastructure.ExportData{DB: pool}
	if _, err := reader.Read(t.Context(), exportScope); err != nil {
		t.Fatal(err)
	}
	// A running API meets migrations: the same connection must read the new columns at once.
	for _, change := range []string{
		`ALTER TABLE module_records ADD COLUMN probe text NOT NULL DEFAULT 'nueva'`,
		`ALTER TABLE module_records DROP COLUMN probe`,
	} {
		if _, err := pool.Exec(t.Context(), change); err != nil {
			t.Fatal(err)
		}
		if _, err := reader.Read(t.Context(), exportScope); err != nil {
			t.Fatalf("after %s: %v", change, err)
		}
	}
}

func TestConcurrentExportsShareNoState(t *testing.T) {
	pool := exportDatabase(t)
	if _, err := pool.Exec(t.Context(), `INSERT INTO automation_rules (tenant_id, name, trigger_module, trigger_actions,
	  actions, created_by, created_at, updated_at) VALUES ('EXP/UNO', 'Regla', '*', '{CREATE}', '[]', 'x', now(), now())`); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			if _, err := (infrastructure.ExportData{DB: pool}).Read(t.Context(), exportScope); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
}

func TestExportIsOneReadOnlySnapshot(t *testing.T) {
	pool := exportDatabase(t)
	tx, err := infrastructure.ExportTransaction{DB: pool}.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var level, readOnly string
	if err := tx.QueryRow(t.Context(), `SELECT current_setting('transaction_isolation'), current_setting('transaction_read_only')`).Scan(&level, &readOnly); err != nil {
		t.Fatal(err)
	}
	if level != "repeatable read" || readOnly != "on" {
		t.Fatalf("transaction: %s, read only %s", level, readOnly)
	}
	if _, err := tx.Exec(t.Context(), `UPDATE tenants SET label = label`); err == nil {
		t.Fatal("the export's transaction accepted a write")
	}
}

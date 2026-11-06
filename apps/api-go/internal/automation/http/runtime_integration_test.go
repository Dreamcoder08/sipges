package http_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
)

const attemptRow = `
INSERT INTO automation_cursors (tenant_id, last_tick_started_at, last_tick_finished_at, last_tick_source,
  last_tick_status, last_tick_report, last_tick_error)
VALUES ($1, '2026-10-06T10:00:00.5Z', '2026-10-06T10:00:02Z', 'cron', 'completed',
  '{"tenants":1,"scanned":4,"queued":2,"executed":2,"failed":0}', $2)
ON CONFLICT (tenant_id) DO UPDATE SET last_tick_started_at = EXCLUDED.last_tick_started_at,
  last_tick_finished_at = EXCLUDED.last_tick_finished_at, last_tick_source = EXCLUDED.last_tick_source,
  last_tick_status = EXCLUDED.last_tick_status, last_tick_report = EXCLUDED.last_tick_report,
  last_tick_error = EXCLUDED.last_tick_error`

func seedAttempt(t *testing.T, tenant, errText string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	if err := tenantRowsArgs(ctx, conn, tenant, attemptRow, tenant, errText); err != nil {
		t.Fatal(err)
	}
}

func tenantRowsArgs(ctx context.Context, conn *pgx.Conn, tenant, sql string, args ...any) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenant); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

const runtimeIdle = `{"event_processing":true,"cron_configured":false,"cron_schedule":null,"interval_ms":0,"latest_attempt":null}`

func TestRuntimeReportsTheServerAndTheScopesLatestAttempt(t *testing.T) {
	base := start(t)
	if scratch == nil {
		t.Skip("no database")
	}
	path := "/system/automations/runtime"

	status, body := get(t, base, path, "", nil)
	expect(t, status, body, http.StatusUnauthorized, signIn)
	status, body = get(t, base, path, "reader", nil)
	expect(t, status, body, http.StatusForbidden, adminOnly)
	status, body = get(t, base, path, "multi", nil)
	expect(t, status, body, http.StatusForbidden, choose)

	status, body = get(t, base, path, "multi", map[string]string{"X-SIPGES-Scope": "SIPGES/PRJ-SECHURA"})
	expect(t, status, body, http.StatusOK, runtimeIdle)

	seedAttempt(t, "ACME/NORTE", "Norte secreto")
	status, body = get(t, base, path, "boss", nil)
	expect(t, status, body, http.StatusOK, runtimeIdle) // another project's attempt stays invisible

	status, body = get(t, base, path, "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
	expect(t, status, body, http.StatusOK, `{"event_processing":true,"cron_configured":false,"cron_schedule":null,"interval_ms":0,`+
		`"latest_attempt":{"started_at":"2026-10-06T10:00:00.500Z","finished_at":"2026-10-06T10:00:02.000Z","source":"cron","status":"completed","error":"Norte secreto",`+
		`"report":{"failed":0,"queued":2,"scanned":4,"tenants":1,"executed":2}}}`)
}

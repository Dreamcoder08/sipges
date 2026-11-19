package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// Ported from "admin-cli reset-mfa recovers the sole administrator, which the HTTP route refuses"
// (apps/api/test/identity/deployment-hardening.test.ts). The scratch is owned by an unprivileged
// login, the role an installation serves with, so the command needs no override.
func TestResetMFARecoversTheSoleAdministrator(t *testing.T) {
	admin := os.Getenv(dbtest.EnvAdminURL)
	if admin == "" {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	ctx := context.Background()
	scratch, err := dbtest.NewOwnedScratch(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = scratch.Drop(context.WithoutCancel(ctx)) })
	if _, err := scratchAsAdmin(ctx, t, admin, scratch.Name).Exec(ctx, `
		INSERT INTO tenants (company_id, project_id, label) VALUES ('SES', 'UNO', 'Uno'), ('SES', 'DOS', 'Dos');
		INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled, totp_secret_sealed, totp_last_step) VALUES
		  ('admin', 'Admin Sintético', 'x', 'admin', true, true, 'sealed-synthetic', 7),
		  ('ana', 'Ana Sintética', 'x', 'analista', true, true, 'sealed-synthetic', 9),
		  ('solo', 'Solo Sintético', 'x', 'analista', true, true, 'sealed-synthetic', 3);
		INSERT INTO grants (username, tenant_id) VALUES ('admin', 'SES/UNO'), ('admin', 'SES/DOS'), ('ana', 'SES/UNO');
		INSERT INTO sessions (token_hash, username, created_at, expires_at, via_google) VALUES
		  (repeat('1', 64), 'admin', '2026-10-12T11:00:00Z', '2099-10-12T19:00:00Z', false),
		  (repeat('2', 64), 'admin', '2026-10-12T11:01:00Z', '2099-10-12T19:01:00Z', false),
		  (repeat('3', 64), 'ana', '2026-10-12T11:02:00Z', '2099-10-12T19:02:00Z', false);`); err != nil {
		t.Fatal(err)
	}
	env := lookup(map[string]string{"SIPGES_DATABASE_URL": scratch.URL})
	state := func(username string) string {
		t.Helper()
		return readState(ctx, t, admin, scratch.Name, username)
	}

	var out, logs bytes.Buffer
	if err := resetMFA(ctx, []string{"reset-mfa", " Admin "}, env, &out, &logs); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); got != "MFA restablecido para admin; registrará un autenticador nuevo al ingresar.\n" {
		t.Fatalf("stdout = %q", got)
	}
	// Enrolment starts over at the next login: no factor, no secret, no session left. Each
	// project the administrator is granted gets one row in its own trail.
	if got := state("admin"); got != "false/-/- sessions=0 audit=2" {
		t.Fatalf("admin after reset = %q", got)
	}
	if got := state("ana"); got != "true/sealed/9 sessions=1 audit=2" {
		t.Fatalf("ana after reset = %q, want untouched", got)
	}
	want := "SES/DOS Cuentas admin MFA_RESET MFA restablecido por el operador del servidor (reset-mfa); sesiones revocadas\n" +
		"SES/UNO Cuentas admin MFA_RESET MFA restablecido por el operador del servidor (reset-mfa); sesiones revocadas"
	if got := auditRows(ctx, t, admin, scratch.Name); got != want {
		t.Fatalf("audit = %q, want %q", got, want)
	}
	assertOperatorLog(t, logs.String(), "admin", "reset")

	// A user without grants has no project trail: the log line is the only trace.
	logs.Reset()
	out.Reset()
	if err := resetMFA(ctx, []string{"reset-mfa", "solo"}, env, &out, &logs); err != nil {
		t.Fatal(err)
	}
	if got := state("solo"); got != "false/-/- sessions=0 audit=2" {
		t.Fatalf("solo after reset = %q", got)
	}
	assertOperatorLog(t, logs.String(), "solo", "reset")

	logs.Reset()
	out.Reset()
	err = resetMFA(ctx, []string{"reset-mfa", "nobody"}, env, &out, &logs)
	var exit *exitError
	if !errors.As(err, &exit) || exit.code != 1 || exit.message != "Usuario inexistente: nobody" || out.Len() != 0 {
		t.Fatalf("nobody: err = %v, stdout = %q", err, out.String())
	}
	assertOperatorLog(t, logs.String(), "nobody", "missing")
	if got := state("admin"); !strings.HasSuffix(got, "audit=2") {
		t.Fatalf("a missing user wrote audit rows: %q", got)
	}

	// dispatch routes the command; its log line goes to the process's stderr.
	out.Reset()
	if err := dispatch(ctx, []string{"reset-mfa", "ana"}, env, &out, net.Listen); err != nil {
		t.Fatal(err)
	}
	if got := state("ana"); got != "false/-/- sessions=0 audit=3" {
		t.Fatalf("ana after reset = %q", got)
	}
}

// assertOperatorLog checks that logs is exactly one JSON line naming the command, the user and
// the outcome, with a timestamp and nothing that could carry a secret.
func assertOperatorLog(t *testing.T, logs, username, outcome string) {
	t.Helper()
	if strings.Count(logs, "\n") != 1 {
		t.Fatalf("want one log line, got %q", logs)
	}
	var line map[string]any
	if err := json.Unmarshal([]byte(logs), &line); err != nil {
		t.Fatalf("log line %q: %v", logs, err)
	}
	if line["msg"] != "operator_command" || line["command"] != "reset-mfa" ||
		line["username"] != username || line["outcome"] != outcome || line["time"] == nil {
		t.Fatalf("log line = %q", logs)
	}
	if len(line) != 6 || line["level"] != "INFO" {
		t.Fatalf("log line has unexpected fields: %q", logs)
	}
}

// auditRows reads every audit row, ordered by tenant, as the admin login.
func auditRows(ctx context.Context, t *testing.T, adminURL, database string) string {
	t.Helper()
	conn := scratchAsAdmin(ctx, t, adminURL, database)
	var s string
	err := conn.QueryRow(ctx, `SELECT coalesce(string_agg(tenant_id || ' ' || module || ' ' || record_id || ' ' ||
	    action || ' ' || detail, E'\n' ORDER BY tenant_id), '') FROM audit`).Scan(&s)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// scratchAsAdmin connects to the scratch database as the admin login, which sees every tenant's
// rows; the connection closes when the test ends.
func scratchAsAdmin(ctx context.Context, t *testing.T, adminURL, database string) *pgx.Conn {
	t.Helper()
	cfg, err := pgx.ParseConfig(adminURL)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Database = database
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.WithoutCancel(ctx)) })
	return conn
}

// readState reads a user's factor, sessions and the whole audit trail.
func readState(ctx context.Context, t *testing.T, adminURL, database, username string) string {
	t.Helper()
	conn := scratchAsAdmin(ctx, t, adminURL, database)
	var s string
	err := conn.QueryRow(ctx, `SELECT totp_enabled::text || '/' ||
	    CASE WHEN totp_secret_sealed IS NULL THEN '-' ELSE 'sealed' END || '/' ||
	    coalesce(totp_last_step::text, '-') ||
	    ' sessions=' || (SELECT count(*) FROM sessions WHERE username = $1) ||
	    ' audit=' || (SELECT count(*) FROM audit)
	  FROM users WHERE username = $1`, username).Scan(&s)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

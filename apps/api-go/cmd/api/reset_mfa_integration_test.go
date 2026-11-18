package main

import (
	"bytes"
	"context"
	"errors"
	"net"
	"os"
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
		INSERT INTO tenants (company_id, project_id, label) VALUES ('SES', 'UNO', 'Uno');
		INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled, totp_secret_sealed, totp_last_step) VALUES
		  ('admin', 'Admin Sintético', 'x', 'admin', true, true, 'sealed-synthetic', 7),
		  ('ana', 'Ana Sintética', 'x', 'analista', true, true, 'sealed-synthetic', 9);
		INSERT INTO grants (username, tenant_id) VALUES ('admin', 'SES/UNO'), ('ana', 'SES/UNO');
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

	var out bytes.Buffer
	if err := dispatch(ctx, []string{"reset-mfa", " Admin "}, env, &out, net.Listen); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); got != "MFA restablecido para admin; registrará un autenticador nuevo al ingresar.\n" {
		t.Fatalf("stdout = %q", got)
	}
	// Enrolment starts over at the next login: no factor, no secret, no session left.
	if got := state("admin"); got != "false/-/- sessions=0 audit=0" {
		t.Fatalf("admin after reset = %q", got)
	}
	if got := state("ana"); got != "true/sealed/9 sessions=1 audit=0" {
		t.Fatalf("ana after reset = %q, want untouched", got)
	}

	out.Reset()
	err = dispatch(ctx, []string{"reset-mfa", "nobody"}, env, &out, net.Listen)
	var exit *exitError
	if !errors.As(err, &exit) || exit.code != 1 || exit.message != "Usuario inexistente: nobody" || out.Len() != 0 {
		t.Fatalf("nobody: err = %v, stdout = %q", err, out.String())
	}
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

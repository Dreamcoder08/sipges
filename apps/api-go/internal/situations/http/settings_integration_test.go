package http_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
)

// PUT /system/v4/settings against a migrated synthetic PostgreSQL, through the composed handler.
// The answers and saved text are checked against TypeScript by
// ../application/settings_fixtures_test.go and the parity runner; these tests pin what reaches
// the tables, tenant isolation and the gates. They own the WRITE tenants, so the read tests' rows
// stay as seeded.

const (
	settingsPath = "/system/v4/settings"
	writeTenant  = "WRITE/PRJ-W"
	otherTenant  = "WRITE/PRJ-OTRO"
)

var writeSeed struct {
	once sync.Once
	err  error
}

func seedWrites(t *testing.T) {
	t.Helper()
	if scratch == nil {
		t.Skip("no scratch database")
	}
	writeSeed.once.Do(func() {
		ctx := context.Background()
		conn, err := pgx.Connect(ctx, scratch.URL)
		if err != nil {
			writeSeed.err = err
			return
		}
		defer func() { _ = conn.Close(ctx) }()
		if _, err := conn.Exec(ctx, `
			INSERT INTO tenants (company_id, project_id, label) VALUES
			  ('WRITE','PRJ-W','Escritura'), ('WRITE','PRJ-OTRO','Otra');
			INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
			  ('wadmin',  'Admin W',    'x', 'admin',       true, true),
			  ('wcoord',  'Coordina W', 'x', 'coordinador', true, true),
			  ('wanalyst','Analista W', 'x', 'analista',    true, true),
			  ('wreader', 'Consulta W', 'x', 'consulta',    true, true);
			INSERT INTO grants (username, tenant_id) VALUES
			  ('wadmin','WRITE/PRJ-W'), ('wadmin','WRITE/PRJ-OTRO'), ('wcoord','WRITE/PRJ-W'),
			  ('wanalyst','WRITE/PRJ-W'), ('wreader','WRITE/PRJ-W');`); err != nil {
			writeSeed.err = err
			return
		}
		if err := tenantRows(ctx, conn, otherTenant, `INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at)
			VALUES ('WRITE/PRJ-OTRO', '{"windowDays": 45}', 'otro', '2026-09-09T09:09:09Z');`); err != nil {
			writeSeed.err = err
			return
		}
		batch := &pgx.Batch{}
		for _, user := range []string{"wadmin", "wcoord", "wanalyst", "wreader"} {
			var b [32]byte
			_, _ = rand.Read(b[:])
			tokens[user] = hex.EncodeToString(b[:])
			batch.Queue(`INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)`,
				infrastructure.HashToken(tokens[user]), user, t0.Add(8*time.Hour))
		}
		writeSeed.err = conn.SendBatch(ctx, batch).Close()
	})
	if writeSeed.err != nil {
		t.Fatal(writeSeed.err)
	}
}

func put(t *testing.T, base, user, body string, scope string) (int, string) {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), http.MethodPut, base+settingsPath, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", base)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Cookie", "sipges_session="+tokens[user])
	if scope != "" {
		r.Header.Set("X-SIPGES-Scope", scope)
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, strings.TrimSpace(string(b))
}

// text reads one text value as the superuser, past row-level security.
func text(t *testing.T, sql string, args ...any) string {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	var s string
	if err := conn.QueryRow(t.Context(), sql, args...).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

func audits(t *testing.T, tenant string) string {
	t.Helper()
	return text(t, `SELECT coalesce(string_agg(module || '|' || action || '|' || detail, ';' ORDER BY ts, id), '')
		FROM audit WHERE tenant_id = $1`, tenant)
}

func TestSettingsUpdateSavesAndAuditsInTheChosenProjectOnly(t *testing.T) {
	seedWrites(t)
	base := start(t)
	otherBefore := text(t, `SELECT settings::text || updated_by FROM project_settings WHERE tenant_id = $1`, otherTenant)

	status, answer := put(t, base, "wadmin", `{"window_days":30,"phase":"cierre"}`, writeTenant)
	if status != http.StatusOK || !strings.Contains(answer, `"window_days":30`) || !strings.Contains(answer, `"phase":"cierre"`) ||
		!strings.Contains(answer, `"updated_by":"wadmin"`) || !strings.Contains(answer, `"updated_at":"2026-11-03T15:00:00.000Z"`) {
		t.Fatalf("got %d %s", status, answer)
	}
	if got := text(t, `SELECT (settings->>'windowDays') || '|' || (settings->>'phase') || '|' || updated_by FROM project_settings
		WHERE tenant_id = $1`, writeTenant); got != "30|cierre|wadmin" {
		t.Fatalf("row %q", got)
	}
	if got := audits(t, writeTenant); got != "SIPGES|CONFIG_UPDATE|Fase Cierre; Campos: windowDays, phase" {
		t.Fatalf("audit %q", got)
	}
	if got := text(t, `SELECT count(*)::text FROM audit WHERE tenant_id = $1 AND record_id IS NULL`, writeTenant); got != "1" {
		t.Fatalf("audit rows without a record: %s", got)
	}

	// The read answers what was saved.
	status, answer = get(t, base, settingsPath, "wanalyst", nil)
	if status != http.StatusOK || !strings.Contains(answer, `"window_days":30`) {
		t.Fatalf("read %d %s", status, answer)
	}

	// Sending the same values changes nothing: no save, no audit row, the row's author stays.
	status, answer = put(t, base, "wadmin", `{"window_days":30}`, writeTenant)
	if status != http.StatusOK || !strings.Contains(answer, `"updated_by":"wadmin"`) {
		t.Fatalf("got %d %s", status, answer)
	}
	if got := audits(t, writeTenant); got != "SIPGES|CONFIG_UPDATE|Fase Cierre; Campos: windowDays, phase" {
		t.Fatalf("audit after no change %q", got)
	}

	if after := text(t, `SELECT settings::text || updated_by FROM project_settings WHERE tenant_id = $1`, otherTenant); after != otherBefore {
		t.Fatalf("the other tenant changed: %q", after)
	}
	if got := audits(t, otherTenant); got != "" {
		t.Fatalf("the other tenant was audited: %q", got)
	}
}

func TestSettingsUpdateIsAdminOnly(t *testing.T) {
	seedWrites(t)
	base := start(t)
	before := text(t, `SELECT count(*)::text FROM audit WHERE tenant_id = $1`, writeTenant)
	for _, user := range []string{"wcoord", "wanalyst", "wreader"} {
		status, answer := put(t, base, user, `{"window_days":40}`, "")
		if status != http.StatusForbidden || answer != `{"detail":"Requiere rol administrador"}` {
			t.Fatalf("%s: got %d %s", user, status, answer)
		}
	}
	if after := text(t, `SELECT count(*)::text FROM audit WHERE tenant_id = $1`, writeTenant); after != before {
		t.Fatalf("audit rows went from %s to %s", before, after)
	}
}

func TestSettingsUpdateRefusesALoneSurrogateAsPostgreSQLDoes(t *testing.T) {
	seedWrites(t)
	base := start(t)
	before := audits(t, otherTenant)
	status, answer := put(t, base, "wadmin", `{"recommendations":{"verificar":"a\ud800b"}}`, otherTenant)
	if status != http.StatusInternalServerError || answer != `{"detail":"Internal Server Error"}` {
		t.Fatalf("got %d %s", status, answer)
	}
	if after := audits(t, otherTenant); after != before {
		t.Fatalf("audit changed: %q", after)
	}
}

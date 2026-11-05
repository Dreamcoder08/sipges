package http_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// The automation write routes, the cron and the wakeup through the composed handler, on a
// scratch database of their own (the read tests' rows stay untouched). Synthetic rows only.

type writeEnv struct {
	base   string
	pool   *pgxpool.Pool
	tokens map[string]string
}

const cronSecret = "cron-sintetico-de-pruebas-0123456789"

func startWrites(t *testing.T) writeEnv {
	t.Helper()
	if scratch == nil {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	s, err := dbtest.NewScratch(t.Context(), os.Getenv(dbtest.EnvAdminURL))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Drop(context.Background()) })
	env := writeEnv{tokens: map[string]string{}}
	conn, err := pgx.Connect(t.Context(), s.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	if _, err := conn.Exec(t.Context(), `
		INSERT INTO tenants (company_id, project_id, label) VALUES ('SIPGES','PRJ-SECHURA','Sechura'), ('ACME','NORTE','Norte');
		INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
		  ('boss', 'Admin', 'x', 'admin', true, true), ('reader', 'Lector', 'x', 'consulta', true, true),
		  ('norte', 'Norte', 'x', 'admin', true, true);
		INSERT INTO grants (username, tenant_id) VALUES ('boss','SIPGES/PRJ-SECHURA'), ('reader','SIPGES/PRJ-SECHURA'),
		  ('norte','ACME/NORTE');`); err != nil {
		t.Fatal(err)
	}
	for _, user := range []string{"boss", "reader", "norte"} {
		var b [32]byte
		_, _ = rand.Read(b[:])
		env.tokens[user] = hex.EncodeToString(b[:])
		if _, err := conn.Exec(t.Context(), `INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)`,
			infrastructure.HashToken(env.tokens[user]), user, time.Now().Add(8*time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("SIPGES_CRON_SECRET", cronSecret)
	env.pool, err = pgxpool.New(t.Context(), s.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(env.pool.Close)
	h, err := app.NewHandler(env.pool, app.Options{Logger: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	env.base = srv.URL
	return env
}

func (e writeEnv) do(t *testing.T, method, path, user, body string, headers map[string]string) (int, string) {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), method, e.base+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if user != "" {
		r.Header.Set("Cookie", "sipges_session="+e.tokens[user])
	}
	r.Header.Set("Origin", e.base)
	r.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, strings.TrimSpace(string(b))
}

func (e writeEnv) count(t *testing.T, sql string) int64 {
	t.Helper()
	var n int64
	if err := e.pool.QueryRow(t.Context(), sql).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// eventually polls cond: the wakeup's tick runs after the response.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

const ruleBody = `{"name":"Eventos sintéticos","module":"Eventos","actions":["CREATE"],"steps":[{"kind":"notify","title":"Nuevo {id}"}]}`

func TestRuleWritesAuditAndWakeTheRuntime(t *testing.T) {
	e := startWrites(t)
	status, body := e.do(t, "POST", "/system/automations/rules", "boss", ruleBody, nil)
	expect(t, status, body, 200, `{"ok":true,"id":1}`)
	// The rule's own write woke the runtime: an event attempt is recorded on the cursor.
	eventually(t, "the wakeup's attempt", func() bool {
		return e.count(t, `SELECT count(*) FROM automation_cursors WHERE tenant_id = 'SIPGES/PRJ-SECHURA' AND last_tick_status = 'completed' AND last_tick_source = 'event'`) == 1
	})
	if n := e.count(t, `SELECT count(*) FROM audit WHERE module = 'Automatizaciones' AND action = 'CREATE' AND record_id = '1' AND detail = 'Regla «Eventos sintéticos» activa'`); n != 1 {
		t.Fatalf("%d audit rows", n)
	}

	status, body = e.do(t, "POST", "/system/automations/rules", "boss", ruleBody, nil)
	expect(t, status, body, 409, `{"detail":"Ya existe una regla con ese nombre"}`)
	status, body = e.do(t, "POST", "/system/automations/rules", "boss", `{"name":"x","module":"Nada","actions":["CREATE"],"steps":[{"kind":"notify","title":"t"}]}`, nil)
	expect(t, status, body, 422, `{"detail":"Origen de eventos no válido"}`)
	status, body = e.do(t, "POST", "/system/automations/rules", "boss", `{"name":"x","module":"Eventos","actions":["CREATE"],"steps":[{"kind":"channel","channel_id":7,"title":"t"}]}`, nil)
	expect(t, status, body, 422, `{"detail":"Acción de la regla no válida o canal inexistente"}`)
	status, body = e.do(t, "POST", "/system/automations/rules", "boss", `{}`, nil)
	expect(t, status, body, 422, `{"detail":[{"type":"missing","loc":["body","name"],"msg":"Field required"},{"type":"missing","loc":["body","module"],"msg":"Field required"},{"type":"missing","loc":["body","actions"],"msg":"Field required"},{"type":"missing","loc":["body","steps"],"msg":"Field required"}]}`)
	status, body = e.do(t, "POST", "/system/automations/rules", "reader", ruleBody, nil)
	if status != 403 {
		t.Fatalf("consulta wrote a rule: %d %s", status, body)
	}

	status, body = e.do(t, "PUT", "/system/automations/rules/1", "boss", strings.Replace(ruleBody, `"module"`, `"enabled":false,"module"`, 1), nil)
	expect(t, status, body, 200, `{"ok":true,"id":1}`)
	status, body = e.do(t, "PUT", "/system/automations/rules/x1", "boss", ruleBody, nil)
	expect(t, status, body, 404, `{"detail":"Regla no encontrada"}`)
	status, body = e.do(t, "PUT", "/system/automations/rules/1234567890", "boss", ruleBody, nil)
	expect(t, status, body, 404, `{"detail":"Regla no encontrada"}`)
	other := strings.Replace(ruleBody, "sintéticos", "otros", 1)
	status, body = e.do(t, "PUT", "/system/automations/rules/99", "boss", other, nil)
	expect(t, status, body, 404, `{"detail":"Regla no encontrada"}`)
	// The name check runs first, as in TypeScript.
	status, body = e.do(t, "PUT", "/system/automations/rules/99", "boss", ruleBody, nil)
	expect(t, status, body, 409, `{"detail":"Ya existe una regla con ese nombre"}`)

	// Another project's rule is invisible: same id, refused as missing, nothing deleted.
	status, body = e.do(t, "POST", "/system/automations/rules", "norte", strings.Replace(ruleBody, "sintéticos", "del norte", 1), nil)
	expect(t, status, body, 200, `{"ok":true,"id":2}`)
	status, body = e.do(t, "DELETE", "/system/automations/rules/2", "boss", "", nil)
	expect(t, status, body, 404, `{"detail":"Regla no encontrada"}`)
	status, body = e.do(t, "PUT", "/system/automations/rules/2", "boss", other, nil)
	expect(t, status, body, 404, `{"detail":"Regla no encontrada"}`)
	if n := e.count(t, `SELECT count(*) FROM automation_rules WHERE id = 2 AND name = 'Eventos del norte'`); n != 1 {
		t.Fatal("norte's rule was changed from another project")
	}
	status, body = e.do(t, "DELETE", "/system/automations/rules/1", "boss", "", nil)
	expect(t, status, body, 200, `{"ok":true}`)
}

func TestTheWakeupFollowsTheTypeScriptRules(t *testing.T) {
	e := startWrites(t)
	attempts := func() int64 {
		return e.count(t, `SELECT count(*) FROM automation_cursors WHERE tenant_id = 'SIPGES/PRJ-SECHURA' AND last_tick_started_at IS NOT NULL`)
	}
	// Refused writes and reads never wake it.
	e.do(t, "POST", "/system/automations/rules", "boss", `{}`, nil)
	e.do(t, "GET", "/system/automations", "boss", "", nil)
	e.do(t, "POST", "/system/notifications/read", "boss", `{"all":true}`, nil) // 2xx, but not a business path
	time.Sleep(200 * time.Millisecond)
	if attempts() != 0 {
		t.Fatal("a refused write, a read or a non-business write woke the runtime")
	}
	status, _ := e.do(t, "POST", "/system/automations/rules", "boss", ruleBody, nil)
	if status != 200 {
		t.Fatal(status)
	}
	eventually(t, "the wakeup", func() bool { return attempts() == 1 })
}

func TestNotificationsAreMarkedReadWithinTheReadersClearance(t *testing.T) {
	e := startWrites(t)
	tx, err := e.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `SELECT set_config('app.tenant_id', 'SIPGES/PRJ-SECHURA', true)`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO notifications (tenant_id, title, body, module, record_id, marking, created_at) VALUES
		('SIPGES/PRJ-SECHURA', 'Interno', '', 'Eventos', 'EV-1', 'interno', now()),
		('SIPGES/PRJ-SECHURA', 'Reservado', '', 'Actores', 'A-9', 'restringido', now())`); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	status, body := e.do(t, "POST", "/system/notifications/read", "reader", `{"all":true}`, nil)
	expect(t, status, body, 200, `{"ok":true}`)
	if n := e.count(t, `SELECT count(*) FROM notification_reads r JOIN notifications n ON n.id = r.notification_id WHERE r.username = 'reader' AND n.marking = 'restringido'`); n != 0 {
		t.Fatal("consulta marked a restricted notification it cannot see")
	}
	if n := e.count(t, `SELECT count(*) FROM notification_reads WHERE username = 'reader'`); n != 1 {
		t.Fatalf("%d reads", n)
	}
	status, body = e.do(t, "POST", "/system/notifications/read", "reader", `{"ids":[0]}`, nil)
	expect(t, status, body, 422, `{"detail":[{"type":"too_small","loc":["body","ids",0],"msg":"Too small: expected number to be >0"}]}`)
}

func TestTheCronNeedsItsBearerSecretAndVisitsEveryCursor(t *testing.T) {
	e := startWrites(t)
	status, body := e.do(t, "POST", "/system/automations/cron", "", "", nil)
	expect(t, status, body, 401, `{"detail":"Credencial de cron no válida"}`)
	status, body = e.do(t, "GET", "/system/automations/cron", "", "", map[string]string{"Authorization": "Bearer otro-secreto-de-24-caracteres"})
	expect(t, status, body, 401, `{"detail":"Credencial de cron no válida"}`)
	status, body = e.do(t, "GET", "/system/automations/cron", "", "", map[string]string{"Authorization": "Bearer " + cronSecret + " "})
	expect(t, status, body, 200, `{"tenants":0,"scanned":0,"queued":0,"delivered":0,"retrying":0,"failed":0}`)
	if status, _ := e.do(t, "POST", "/system/automations/rules", "boss", ruleBody, nil); status != 200 {
		t.Fatal(status)
	}
	eventually(t, "the cursor", func() bool {
		return e.count(t, `SELECT count(*) FROM automation_cursors WHERE last_tick_status = 'completed'`) == 1
	})
	status, body = e.do(t, "POST", "/system/automations/cron", "", "", map[string]string{"Authorization": "Bearer " + cronSecret})
	if status != 200 || !strings.HasPrefix(body, `{"tenants":1,`) {
		t.Fatalf("cron %d %s", status, body)
	}
}

func TestTheTickRouteRunsTheProjectsTick(t *testing.T) {
	e := startWrites(t)
	status, body := e.do(t, "POST", "/system/automations/tick", "boss", "", nil)
	expect(t, status, body, 200, `{"tenants":1,"scanned":0,"queued":0,"delivered":0,"retrying":0,"failed":0}`)
	status, body = e.do(t, "POST", "/system/automations/channels", "boss", `{"kind":"slack","name":"Canal","settings":{"url":"https://evil.example.org/x"}}`, nil)
	expect(t, status, body, 422, `{"detail":"La URL no corresponde al servicio elegido"}`)
	status, body = e.do(t, "DELETE", "/system/automations/channels/5", "boss", "", nil)
	expect(t, status, body, 404, `{"detail":"Canal no encontrado"}`)
	status, body = e.do(t, "POST", "/system/automations/channels/x/test", "boss", "", nil)
	expect(t, status, body, 404, `{"detail":"Canal no encontrado"}`)
}

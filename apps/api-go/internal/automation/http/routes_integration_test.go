package http_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app/apitest"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// The automation read routes against a migrated synthetic PostgreSQL, through the composed
// handler (session, project scope, role gate). Every account, project, rule and notification is
// synthetic. ACME/NORTE reuses names and ids of SIPGES/PRJ-SECHURA, so only row-level security
// keeps its rows out.

var scratch *dbtest.Scratch

func TestMain(m *testing.M) { os.Exit(run(m)) }

func run(m *testing.M) int {
	adminURL := os.Getenv(dbtest.EnvAdminURL)
	if adminURL == "" {
		return m.Run() // integration tests skip themselves
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	s, err := dbtest.NewScratch(ctx, adminURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "scratch database:", err)
		return 1
	}
	defer func() {
		if err := s.Drop(context.Background()); err != nil {
			fmt.Fprintln(os.Stderr, "drop scratch database:", err)
		}
	}()
	if err := seed(ctx, s.URL); err != nil {
		fmt.Fprintln(os.Stderr, "seed scratch database:", err)
		return 1
	}
	scratch = s
	return m.Run()
}

var t0 = time.Date(2026, 11, 3, 11, 0, 0, 0, time.UTC)

var tokens = map[string]string{}

// tenantRows inserts one tenant's rows inside a transaction entered as that tenant.
func tenantRows(ctx context.Context, conn *pgx.Conn, tenant, sql string) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenant); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, sql); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

const sechuraRows = `
INSERT INTO integration_channels (tenant_id, kind, name, target_hint, sealed_config, created_by, created_at) VALUES
  ('SIPGES/PRJ-SECHURA', 'webhook', 'Webhook operaciones', 'hooks.example.org', 'sellado', 'boss', '2026-10-01T08:00:00.5Z');
INSERT INTO automation_rules (tenant_id, name, enabled, trigger_module, trigger_actions, conditions, actions,
  created_by, created_at, updated_at) VALUES
  ('SIPGES/PRJ-SECHURA', 'Avisos de alertas', true, 'Alertas', '{CREATE,UPDATE}',
   '[{"field":"Nivel","op":"eq","value":"Alto"}]',
   '[{"kind":"notify","title":"Nueva {{module}}"},{"kind":"channel","channelId":1,"title":"Canal <ops>"}]',
   'boss', '2026-10-01T08:00:00Z', '2026-10-02T09:30:15.75Z'),
  ('SIPGES/PRJ-SECHURA', 'Bitácora', false, '*', '{DELETE}', '[]',
   '[{"kind":"evaluate","title":"Evaluar","minimumLevel":"Alta"}]', 'boss', '2026-10-01T08:00:00Z', '2026-10-01T08:00:00Z');
INSERT INTO automation_runs (tenant_id, rule_id, audit_id, action_index, kind, status, attempts, next_attempt_at,
  last_error, event, created_at, finished_at) VALUES
  ('SIPGES/PRJ-SECHURA', 1, 10, 0, 'notify', 'done', 1, '2026-10-03T10:00:00Z', '',
   '{"auditId":10,"at":"2026-10-03T09:59:30.120Z","module":"Alertas","recordId":"AL-1","action":"CREATE","detail":"Alerta AL-1 creada","record":{"payload":{"Nivel":"Alto"},"marking":"interno"}}',
   '2026-10-03T10:00:00Z', '2026-10-03T10:00:05.9Z'),
  ('SIPGES/PRJ-SECHURA', 1, 11, 1, 'channel', 'pending', 2, '2026-10-04T10:05:00Z', 'HTTP 503',
   '{"auditId":11,"at":"2026-10-04T09:59:00.000Z","module":"Alertas","recordId":"AL-2","action":"UPDATE","detail":"Detalle reservado","record":{"payload":{},"marking":"restringido"}}',
   '2026-10-04T10:00:00Z', NULL);
INSERT INTO notifications (tenant_id, title, body, module, record_id, marking, rule_id, created_at) VALUES
  ('SIPGES/PRJ-SECHURA', 'Nueva Alertas', 'Alerta AL-1 creada', 'Alertas', 'AL-1', 'interno', 1, '2026-10-03T10:00:01Z'),
  ('SIPGES/PRJ-SECHURA', 'Aviso reservado', 'Registro reservado', 'Actores', 'A-9', 'restringido', 1, '2026-10-03T11:00:00Z'),
  ('SIPGES/PRJ-SECHURA', 'Alerta digital', '', 'InteligenciaDigital', 'DA 1/2', 'publico', NULL, '2026-10-03T12:00:00.999Z'),
  ('SIPGES/PRJ-SECHURA', 'Aviso del sistema', 'Sin registro', NULL, NULL, 'interno', NULL, '2026-10-03T13:00:00Z');
INSERT INTO notification_reads (tenant_id, notification_id, username, read_at) VALUES
  ('SIPGES/PRJ-SECHURA', 1, 'solo', '2026-10-05T00:00:00Z'),
  ('SIPGES/PRJ-SECHURA', 3, 'reader', '2026-10-05T00:00:00Z');`

const norteRows = `
INSERT INTO integration_channels (tenant_id, kind, name, target_hint, sealed_config, created_by, created_at) VALUES
  ('ACME/NORTE', 'slack', 'Webhook operaciones', 'hooks.slack.com', 'sellado', 'norte', '2026-10-01T00:00:00Z');
INSERT INTO automation_rules (tenant_id, name, enabled, trigger_module, trigger_actions, conditions, actions,
  created_by, created_at, updated_at) VALUES
  ('ACME/NORTE', 'Avisos de alertas', true, 'Eventos', '{CREATE}', '[]', '[{"kind":"notify","title":"Norte secreto"}]',
   'norte', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
INSERT INTO automation_runs (tenant_id, rule_id, audit_id, action_index, kind, status, attempts, next_attempt_at,
  last_error, event, created_at, finished_at) VALUES
  ('ACME/NORTE', 3, 10, 0, 'notify', 'failed', 5, '2026-10-01T00:00:00Z', 'Norte secreto',
   '{"auditId":10,"at":"2026-10-01T00:00:00Z","module":"Eventos","recordId":"EV-1","action":"CREATE","detail":"Norte secreto","record":null}',
   '2026-10-01T00:00:00Z', '2026-10-01T00:10:00Z');
INSERT INTO notifications (tenant_id, title, body, module, record_id, marking, rule_id, created_at) VALUES
  ('ACME/NORTE', 'Norte secreto', 'Norte secreto', 'Eventos', 'EV-1', 'interno', 3, '2026-10-01T00:00:00Z');`

func seed(ctx context.Context, dsn string) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(ctx) }()
	if _, err := conn.Exec(ctx, `
		INSERT INTO tenants (company_id, project_id, label) VALUES
		  ('SIPGES','PRJ-SECHURA','Sechura'), ('ACME','NORTE','Norte') ON CONFLICT DO NOTHING;
		INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
		  ('boss',   'Solo Admin',   'x', 'admin',    true, true),
		  ('multi',  'Multi Admin',  'x', 'admin',    true, true),
		  ('solo',   'Solo Analyst', 'x', 'analista', true, true),
		  ('reader', 'Read Only',    'x', 'consulta', true, true);
		INSERT INTO grants (username, tenant_id) VALUES
		  ('boss','SIPGES/PRJ-SECHURA'), ('multi','SIPGES/PRJ-SECHURA'), ('multi','ACME/NORTE'),
		  ('solo','SIPGES/PRJ-SECHURA'), ('reader','SIPGES/PRJ-SECHURA');`); err != nil {
		return err
	}
	if err := tenantRows(ctx, conn, "SIPGES/PRJ-SECHURA", sechuraRows); err != nil {
		return fmt.Errorf("sechura: %w", err)
	}
	if err := tenantRows(ctx, conn, "ACME/NORTE", norteRows); err != nil {
		return fmt.Errorf("norte: %w", err)
	}
	batch := &pgx.Batch{}
	for _, user := range []string{"boss", "multi", "solo", "reader"} {
		var b [32]byte
		_, _ = rand.Read(b[:])
		tokens[user] = hex.EncodeToString(b[:])
		batch.Queue(`INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)`,
			infrastructure.HashToken(tokens[user]), user, t0.Add(8*time.Hour))
	}
	return conn.SendBatch(ctx, batch).Close()
}

func start(t *testing.T) string {
	t.Helper()
	return apitest.Start(t, scratch, t0)
}

func get(t *testing.T, base, path, user string, headers map[string]string) (int, string) {
	t.Helper()
	return apitest.Get(t, base, path, tokens[user], headers)
}

var expect = apitest.Expect

const (
	rulesSechura = `[{"id":1,"name":"Avisos de alertas","enabled":true,"module":"Alertas","actions":["CREATE","UPDATE"],` +
		`"conditions":[{"op":"eq","field":"Nivel","value":"Alto"}],` +
		`"steps":[{"kind":"notify","title":"Nueva {{module}}"},{"kind":"channel","channel_id":1,"title":"Canal <ops>"}],` +
		`"created_by":"boss","updated_at":"2026-10-02T09:30:15Z"},` +
		`{"id":2,"name":"Bitácora","enabled":false,"module":"*","actions":["DELETE"],"conditions":[],` +
		`"steps":[{"kind":"evaluate","title":"Evaluar","minimum_level":"Alta"}],"created_by":"boss","updated_at":"2026-10-01T08:00:00Z"}]`
	channelsSechura = `[{"id":1,"kind":"webhook","name":"Webhook operaciones","target_hint":"hooks.example.org","created_by":"boss","created_at":"2026-10-01T08:00:00Z"}]`
	run2            = `{"id":2,"rule_id":1,"rule_name":"Avisos de alertas","kind":"channel","status":"pending","attempts":2,"last_error":"HTTP 503",` +
		`"event":{"audit_id":11,"at":"2026-10-04T09:59:00Z","module":"Alertas","record_id":"AL-2","action":"UPDATE","detail":""},` +
		`"created_at":"2026-10-04T10:00:00Z","finished_at":null,"next_attempt_at":"2026-10-04T10:05:00Z"}`
	run1 = `{"id":1,"rule_id":1,"rule_name":"Avisos de alertas","kind":"notify","status":"done","attempts":1,"last_error":"",` +
		`"event":{"audit_id":10,"at":"2026-10-03T09:59:30Z","module":"Alertas","record_id":"AL-1","action":"CREATE","detail":"Alerta AL-1 creada"},` +
		`"created_at":"2026-10-03T10:00:00Z","finished_at":"2026-10-03T10:00:05Z","next_attempt_at":"2026-10-03T10:00:00Z"}`
	runsSechura = `[` + run2 + `,` + run1 + `]`
	rulesNorte  = `[{"id":3,"name":"Avisos de alertas","enabled":true,"module":"Eventos","actions":["CREATE"],"conditions":[],` +
		`"steps":[{"kind":"notify","title":"Norte secreto"}],"created_by":"norte","updated_at":"2026-10-01T00:00:00Z"}]`
	channelsNorte = `[{"id":2,"kind":"slack","name":"Webhook operaciones","target_hint":"hooks.slack.com","created_by":"norte","created_at":"2026-10-01T00:00:00Z"}]`
	runsNorte     = `[{"id":3,"rule_id":3,"rule_name":"Avisos de alertas","kind":"notify","status":"failed","attempts":5,"last_error":"Norte secreto",` +
		`"event":{"audit_id":10,"at":"2026-10-01T00:00:00Z","module":"Eventos","record_id":"EV-1","action":"CREATE","detail":"Norte secreto"},` +
		`"created_at":"2026-10-01T00:00:00Z","finished_at":"2026-10-01T00:10:00Z","next_attempt_at":"2026-10-01T00:00:00Z"}]`

	n4 = `{"id":4,"title":"Aviso del sistema","body":"Sin registro","module":null,"record_id":null,"link":null,"created_at":"2026-10-03T13:00:00Z","read":false}`
	n3 = `{"id":3,"title":"Alerta digital","body":"","module":"InteligenciaDigital","record_id":"DA 1/2","href":"/inteligencia-redes?alert=DA%%201%%2F2","link":null,"created_at":"2026-10-03T12:00:00Z","read":%t}`
	n2 = `{"id":2,"title":"Aviso reservado","body":"Registro reservado","module":"Actores","record_id":"A-9","link":{"module":"actores","id":"A-9"},"created_at":"2026-10-03T11:00:00Z","read":false}`
	n1 = `{"id":1,"title":"Nueva Alertas","body":"Alerta AL-1 creada","module":"Alertas","record_id":"AL-1","link":{"module":"alertas","id":"AL-1"},"created_at":"2026-10-03T10:00:01Z","read":%t}`

	signIn     = `{"detail":"Inicie sesión para acceder a SIPGES"}`
	adminOnly  = `{"detail":"Requiere rol administrador"}`
	outOfScope = `{"detail":"Proyecto fuera de alcance"}`
	choose     = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["ACME/NORTE","SIPGES/PRJ-SECHURA"]}`
	chooseSolo = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["SIPGES/PRJ-SECHURA"]}`
	notFound   = `{"detail":"Not Found"}`
	badLimit   = `{"detail":[{"type":"int_parsing","loc":["query","limit"],"msg":"Input should be a valid integer, unable to parse string as an integer"}]}`
)

func overview(t *testing.T, rules, channels, runs string) string {
	t.Helper()
	part := func(v any) string {
		b, err := application.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	// The key order of automation-routes.ts: sources, actions, operators, rules, channels, runs.
	return `{"sources":` + part(domain.Sources()) + `,"actions":` + part(domain.EventActions) +
		`,"operators":` + part(domain.ConditionOps) + `,"rules":` + rules + `,"channels":` + channels + `,"runs":` + runs + `}`
}

func TestOverviewAndRunsOfTheResolvedProject(t *testing.T) {
	base := start(t)
	status, body := get(t, base, "/system/automations", "boss", nil)
	expect(t, status, body, http.StatusOK, overview(t, rulesSechura, channelsSechura, runsSechura))
	status, body = get(t, base, "/system/automations?project_id=PRJ-SECHURA", "boss", nil)
	expect(t, status, body, http.StatusOK, overview(t, rulesSechura, channelsSechura, runsSechura))
	// A two-project administrator sees each project's rows only, never the other tenant's.
	status, body = get(t, base, "/system/automations", "multi", map[string]string{"X-SIPGES-Scope": "SIPGES/PRJ-SECHURA"})
	expect(t, status, body, http.StatusOK, overview(t, rulesSechura, channelsSechura, runsSechura))
	status, body = get(t, base, "/system/automations", "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
	expect(t, status, body, http.StatusOK, overview(t, rulesNorte, channelsNorte, runsNorte))

	for _, c := range []struct{ query, want string }{
		{"", runsSechura}, {"?limit=1", `[` + run2 + `]`}, {"?limit=0", `[` + run2 + `]`}, {"?limit=-3", `[` + run2 + `]`},
		{"?limit=%20%2B2%20", runsSechura}, {"?limit=99999999999999999999", runsSechura},
	} {
		status, body = get(t, base, "/system/automations/runs"+c.query, "boss", nil)
		expect(t, status, body, http.StatusOK, c.want)
	}
	status, body = get(t, base, "/system/automations/runs", "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
	expect(t, status, body, http.StatusOK, runsNorte)
	for _, q := range []string{"?limit=abc", "?limit=1.5", "?limit=", "?limit=1e2", "?limit=--1"} {
		status, body = get(t, base, "/system/automations/runs"+q, "boss", nil)
		expect(t, status, body, http.StatusUnprocessableEntity, badLimit)
	}
}

func TestInboxIsTheUsersOwnAndFollowsTheClearance(t *testing.T) {
	base := start(t)
	// The analyst read n1; it sees every marking.
	status, body := get(t, base, "/system/notifications", "solo", nil)
	expect(t, status, body, http.StatusOK, `{"unread":3,"items":[`+n4+`,`+fmt.Sprintf(n3, false)+`,`+n2+`,`+fmt.Sprintf(n1, true)+`]}`)
	// The read-only role never sees the restricted notification, not even in the count.
	status, body = get(t, base, "/system/notifications", "reader", nil)
	expect(t, status, body, http.StatusOK, `{"unread":2,"items":[`+n4+`,`+fmt.Sprintf(n3, true)+`,`+fmt.Sprintf(n1, false)+`]}`)
	status, body = get(t, base, "/system/notifications?limit=2", "solo", nil)
	expect(t, status, body, http.StatusOK, `{"unread":3,"items":[`+n4+`,`+fmt.Sprintf(n3, false)+`]}`)
	status, body = get(t, base, "/system/notifications?limit=0", "solo", nil)
	expect(t, status, body, http.StatusOK, `{"unread":3,"items":[`+n4+`]}`)
	status, body = get(t, base, "/system/notifications", "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
	expect(t, status, body, http.StatusOK, `{"unread":1,"items":[{"id":5,"title":"Norte secreto","body":"Norte secreto","module":"Eventos","record_id":"EV-1","link":{"module":"eventos","id":"EV-1"},"created_at":"2026-10-01T00:00:00Z","read":false}]}`)
	status, body = get(t, base, "/system/notifications?limit=x", "reader", nil)
	expect(t, status, body, http.StatusUnprocessableEntity, badLimit)
}

func TestRefusesRequestsOutsideTheScopeOrRole(t *testing.T) {
	base := start(t)
	for _, path := range []string{"/system/automations", "/system/automations/runs", "/system/notifications"} {
		t.Run(path, func(t *testing.T) {
			status, body := get(t, base, path, "", nil)
			expect(t, status, body, http.StatusUnauthorized, signIn)
			status, body = get(t, base, path, "solo", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
			expect(t, status, body, http.StatusForbidden, chooseSolo)
			status, body = get(t, base, path+"?project_id=NORTE", "boss", nil)
			expect(t, status, body, http.StatusForbidden, outOfScope)
			status, body = get(t, base, path, "multi", nil)
			expect(t, status, body, http.StatusForbidden, choose)
		})
	}
	// Rules, channels and runs are for administrators only; the gate answers before the limit.
	for _, user := range []string{"solo", "reader"} {
		for _, path := range []string{"/system/automations", "/system/automations/runs", "/system/automations/runs?limit=x"} {
			status, body := get(t, base, path, user, nil)
			expect(t, status, body, http.StatusForbidden, adminOnly)
		}
	}
	for _, path := range []string{"/system/automations/", "/system/notifications/", "/system/automations/rules"} {
		status, body := get(t, base, path, "boss", nil)
		expect(t, status, body, http.StatusNotFound, notFound)
	}
}

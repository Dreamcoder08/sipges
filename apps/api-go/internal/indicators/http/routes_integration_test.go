package http_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app/apitest"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/engines"
)

// The indicators read routes against a migrated synthetic PostgreSQL, through the composed
// handler (session, project scope, role gate) and the embedded Rust engine. Every account,
// project and record is synthetic.

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

// tenantRows inserts one tenant's rows inside a transaction entered as that tenant, so the
// row-level security policies hold even for a non-superuser test login.
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

const (
	sechuraConfig = `{"version":"0.4-indicators","weights":{"G":0.5,"A":0.1,"D":0.1,"N":0.1,"E":0.1,"I":0.1},` +
		`"thresholds":{"Rojo":[60,100],"Naranja":[40,59.99],"Amarillo":[20,39.99],"Verde":[0,19.99]},` +
		`"contributions":{"active_alert":10},"extra":"conservado"}`
	norteConfig = `{"weights":{"G":1},"thresholds":{"AJENA":[0,100]},"contributions":{}}`
)

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
		  ('multi',  'Multi Admin',  'x', 'admin',    true, true),
		  ('solo',   'Solo Analyst', 'x', 'analista', true, true),
		  ('reader', 'Read Only',    'x', 'consulta', true, true);
		INSERT INTO grants (username, tenant_id) VALUES
		  ('multi','SIPGES/PRJ-SECHURA'), ('multi','ACME/NORTE'),
		  ('solo','SIPGES/PRJ-SECHURA'), ('reader','SIPGES/PRJ-SECHURA');`); err != nil {
		return err
	}
	sechura := `
		INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking) VALUES
		  ('SIPGES/PRJ-SECHURA','Eventos','EV-1','{"Relevancia_Preliminar": "Alta", "Dimension_Principal": "Gobernanza", "_id": "del-payload"}',
		   '2026-01-03T00:00:00Z','2026-01-03T00:00:00Z','interno'),
		  ('SIPGES/PRJ-SECHURA','Eventos','EV-2','{"Dimension_Principal": "Ambiental", "Relevancia_Preliminar": "Crítica"}',
		   '2026-01-03T00:00:00Z','2026-01-03T00:00:00Z','restringido'),
		  ('SIPGES/PRJ-SECHURA','Alertas','AL-1','{}','2026-01-03T00:00:00Z','2026-01-03T00:00:00Z','publico'),
		  ('SIPGES/PRJ-SECHURA','Otro_Modulo','OT-1','{"Estado": "Abierta"}','2026-01-03T00:00:00Z','2026-01-03T00:00:00Z','interno');
		INSERT INTO irsa_configs (tenant_id, config) VALUES ('SIPGES/PRJ-SECHURA', '` + sechuraConfig + `');
		INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at) VALUES
		  ('SIPGES/PRJ-SECHURA', '{"phase": "operacion", "phaseWeights": {"operacion": {"G": 0.3, "A": 0.1, "D": 0.2, "N": 0.1, "E": 0.2, "I": 0.1}}}',
		   'multi', '2026-01-03T00:00:00Z');
		INSERT INTO irsa_snapshots (tenant_id, ts, irsa, level, scores, config_version, note) VALUES
		  ('SIPGES/PRJ-SECHURA','2026-01-05T10:00:00.789Z',42.5,'Amarillo','{"G":40,"A":45.25}','0.4-indicators','Corte'),
		  ('SIPGES/PRJ-SECHURA','2026-01-06T08:30:00Z',61.75,'Naranja','{"G": 60.5}',NULL,NULL);`
	if err := tenantRows(ctx, conn, "SIPGES/PRJ-SECHURA", sechura); err != nil {
		return fmt.Errorf("sechura: %w", err)
	}
	// Another tenant reuses the record ids: only RLS keeps them out of Sechura. Its phase has no
	// saved weights, so its own configuration applies unchanged.
	norte := `
		INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at) VALUES
		  ('ACME/NORTE','Eventos','EV-1','{"Descripcion_Hecho": "Conflicto AJENA", "Relevancia_Preliminar": "Crítica"}',
		   '2026-01-02T00:00:00Z','2026-01-02T00:00:00Z');
		INSERT INTO irsa_configs (tenant_id, config) VALUES ('ACME/NORTE', '` + norteConfig + `');
		INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at) VALUES
		  ('ACME/NORTE', '{"phase": "cierre", "phaseWeights": {"operacion": {"E": 1}}}', 'multi', '2026-01-02T00:00:00Z');
		INSERT INTO irsa_snapshots (tenant_id, ts, irsa, level, scores) VALUES
		  ('ACME/NORTE','2026-01-04T00:00:00Z',99.99,'AJENA','{"G":99.99}');`
	if err := tenantRows(ctx, conn, "ACME/NORTE", norte); err != nil {
		return fmt.Errorf("norte: %w", err)
	}
	batch := &pgx.Batch{}
	for _, user := range []string{"multi", "solo", "reader"} {
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

// engine answers a request the way the routes should have built it.
func engine(t *testing.T, request string) string {
	t.Helper()
	set, err := engines.Shared(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	value, err := set.Indicators.Call(t.Context(), []byte(request))
	if err != nil {
		t.Fatal(err)
	}
	return string(value)
}

// records is the engine's `records` with the given Eventos and Alertas; every other module empty.
//
//nolint:misspell // Spanish module names, verbatim from the TypeScript API.
func records(eventos, alertas string) string {
	return `{"Eventos":[` + eventos + `],"Actores":[],"Demandas":[],"Compromisos":[],"Narrativas":[],` +
		`"Alertas":[` + alertas + `],"Acciones":[],"Directorio_Territorial":[]}`
}

var (
	ev1 = `{"_id":"EV-1","Dimension_Principal":"Gobernanza","Relevancia_Preliminar":"Alta"}`
	ev2 = `{"_id":"EV-2","Dimension_Principal":"Ambiental","Relevancia_Preliminar":"Crítica"}`
	al1 = `{"_id":"AL-1"}`
	// Full clearance reads the restricted record; the read-only role does not.
	sechuraFull    = records(ev1+","+ev2, al1)
	sechuraLimited = records(ev1, al1)
	norteRecords   = records(`{"Descripcion_Hecho":"Conflicto AJENA","Relevancia_Preliminar":"Crítica","_id":"EV-1"}`, "")
	phaseWeights   = `{"A":0.1,"D":0.2,"E":0.2,"G":0.3,"I":0.1,"N":0.1}`
	phaseConfig    = strings.Replace(sechuraConfig, `{"G":0.5,"A":0.1,"D":0.1,"N":0.1,"E":0.1,"I":0.1}`, phaseWeights, 1)

	historySechura = `[{"id":2,"ts":"2026-01-06T08:30:00Z","irsa":61.75,"level":"Naranja","scores":{"G":60.5},"config_version":null,"note":null},` +
		`{"id":1,"ts":"2026-01-05T10:00:00Z","irsa":42.5,"level":"Amarillo","scores":{"G":40,"A":45.25},"config_version":"0.4-indicators","note":"Corte"}]`
	historyNorte = `[{"id":3,"ts":"2026-01-04T00:00:00Z","irsa":99.99,"level":"AJENA","scores":{"G":99.99},"config_version":null,"note":null}]`
	limitError   = `{"detail":[{"type":"int_parsing","loc":["query","limit"],"msg":"Input should be a valid integer, unable to parse string as an integer"}]}`

	signIn     = `{"detail":"Inicie sesión para acceder a SIPGES"}`
	chooseSolo = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["SIPGES/PRJ-SECHURA"]}`
	choose     = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["ACME/NORTE","SIPGES/PRJ-SECHURA"]}`
)

var (
	sechura = map[string]string{"X-SIPGES-Scope": "SIPGES/PRJ-SECHURA"}
	norte   = map[string]string{"X-SIPGES-Scope": "ACME/NORTE"}
)

func TestServesTheIndicatorsOfTheResolvedProject(t *testing.T) {
	base := start(t)
	full := engine(t, `{"op":"indicators","records":`+sechuraFull+`}`)
	limited := engine(t, `{"op":"indicators","records":`+sechuraLimited+`}`)
	if full == limited {
		t.Fatal("the restricted record changes nothing; the case proves nothing")
	}
	status, body := get(t, base, "/system/indicators", "solo", nil)
	expect(t, status, body, http.StatusOK, full)
	status, body = get(t, base, "/system/indicators", "reader", nil)
	expect(t, status, body, http.StatusOK, limited)
	status, body = get(t, base, "/system/indicators", "multi", norte)
	expect(t, status, body, http.StatusOK, engine(t, `{"op":"indicators","records":`+norteRecords+`}`))
}

func TestServesTheIrsaWithThePhaseWeights(t *testing.T) {
	base := start(t)
	status, body := get(t, base, "/system/irsa", "solo", nil)
	if status != http.StatusOK {
		t.Fatalf("status %d %s", status, body)
	}
	plain := engine(t, `{"op":"irsa","config":`+phaseConfig+`,"records":`+sechuraFull+`}`)
	// {...result, phase, notes: [...notes, note]}: notes stays in place, phase comes last.
	wantPrefix := plain[:strings.LastIndex(plain, `]}`)]
	want := wantPrefix + `,"Pesos de la fase Operación del proyecto (SIPGES), preliminares hasta su validación."],` +
		`"phase":{"id":"operacion","label":"Operación"}}`
	expect(t, status, body, http.StatusOK, want)
	var got struct {
		Weights json.RawMessage `json:"weights"`
		Level   string          `json:"level"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	if string(got.Weights) != phaseWeights {
		t.Fatalf("weights %s, want the phase's %s", got.Weights, phaseWeights)
	}
	// The other tenant's own configuration, with no phase weights, and none of Sechura's rows.
	status, body = get(t, base, "/system/irsa", "multi", norte)
	expect(t, status, body, http.StatusOK, engine(t, `{"op":"irsa","config":`+norteConfig+`,"records":`+norteRecords+`}`))
	if !strings.Contains(body, `"level":"AJENA"`) || strings.Contains(body, "phase") {
		t.Fatalf("norte irsa: %s", body)
	}
}

func TestServesTheConfigurationAndHistory(t *testing.T) {
	base := start(t)
	for _, c := range []struct{ path, user string }{{"/system/irsa/config", "solo"}, {"/system/irsa/config", "reader"}} {
		status, body := get(t, base, c.path, c.user, nil)
		expect(t, status, body, http.StatusOK, sechuraConfig)
	}
	status, body := get(t, base, "/system/irsa/config", "multi", norte)
	expect(t, status, body, http.StatusOK, norteConfig)

	for _, c := range []struct {
		query, user string
		headers     map[string]string
		status      int
		body        string
	}{
		{"", "solo", nil, http.StatusOK, historySechura},
		{"", "reader", nil, http.StatusOK, historySechura},
		{"?limit=1", "solo", nil, http.StatusOK, `[` + historySechura[1:strings.Index(historySechura, `},{`)+1] + `]`},
		{"?limit=-1", "multi", sechura, http.StatusOK, historySechura},
		{"?limit=0", "solo", nil, http.StatusOK, `[]`},
		{"?limit=abc", "solo", nil, http.StatusUnprocessableEntity, limitError},
		{"?limit=1.5", "solo", nil, http.StatusUnprocessableEntity, limitError},
		{"", "multi", norte, http.StatusOK, historyNorte},
	} {
		status, body := get(t, base, "/system/irsa/history"+c.query, c.user, c.headers)
		expect(t, status, body, c.status, c.body)
	}
}

func TestServesTheStaticDocuments(t *testing.T) {
	base := start(t)
	status, body := get(t, base, "/system/model-status", "reader", nil)
	if status != http.StatusOK || !strings.HasPrefix(body, `{"version":"SIPGES · Prototipo final de tesis | Motor V0.5.1",`) ||
		!strings.HasSuffix(body, `"ui_release":"Web Final RC 1.0"}`) {
		t.Fatalf("model status: %d %s", status, body)
	}
	status, body = get(t, base, "/system/validation-template", "reader", nil)
	var template struct {
		Status string            `json:"status"`
		Rows   []json.RawMessage `json:"rows"`
	}
	if err := json.Unmarshal([]byte(body), &template); err != nil || status != http.StatusOK {
		t.Fatalf("validation template: %d %s", status, body)
	}
	first := `{"dimension":"G","code":"G1","name":"Validez de representación","definition":"Riesgo derivado de interlocutores con representación fragmentada, limitada o pendiente de validación.",` +
		`"expert_1":null,"expert_2":null,"expert_3":null,"expert_4":null,"expert_5":null,"aiken_v":null,"decision":"Pendiente"}`
	if template.Status != "PENDIENTE" || len(template.Rows) != 32 || string(template.Rows[0]) != first {
		t.Fatalf("validation template: %s %d %s", template.Status, len(template.Rows), template.Rows[0])
	}
}

func TestRefusesRequestsOutsideTheScope(t *testing.T) {
	base := start(t)
	for _, path := range []string{
		"/system/irsa", "/system/irsa/config", "/system/irsa/history", "/system/indicators",
		"/system/model-status", "/system/validation-template",
	} {
		t.Run(path, func(t *testing.T) {
			status, body := get(t, base, path, "", nil)
			expect(t, status, body, http.StatusUnauthorized, signIn)
			status, body = get(t, base, path, "solo", norte)
			expect(t, status, body, http.StatusForbidden, chooseSolo)
			status, body = get(t, base, path, "multi", nil)
			expect(t, status, body, http.StatusForbidden, choose)
		})
	}
	status, body := get(t, base, "/system/irsa/history?limit=abc", "", nil)
	expect(t, status, body, http.StatusUnauthorized, signIn)
}

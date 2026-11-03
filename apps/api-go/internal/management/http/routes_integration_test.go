//nolint:misspell // Spanish field names and messages, verbatim from the TypeScript API.
package http_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// Integration tests of the management routes through the composed handler, against a migrated
// synthetic PostgreSQL: the overview and CSV of apps/api/src/contexts/management, the session
// and scope gates in front of them, tenant isolation and the read-only role's clearance.
// Every account, project and row here is synthetic.

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

// t0 is the synthetic "now": Lima's day is 2026-11-03.
var t0 = time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)

var tokens = map[string]string{}

const alertColumns = `tenant_id, id, project_id, created_at, source_url, source_type, excerpt, sha256, level,
	score, method, themes, signals, suggestions, semantic_active, status, analyst_note, reviewed_at`

func seed(ctx context.Context, dsn string) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(ctx) }()
	sha := strings.Repeat("a", 64)
	if _, err := conn.Exec(ctx, `
		INSERT INTO tenants (company_id, project_id, label) VALUES
		  ('SIPGES','PRJ-SECHURA','Sechura'), ('ACME','NORTE','Norte') ON CONFLICT DO NOTHING;
		INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
		  ('multi',  'Multi Admin',  'x', 'admin',    true, true),
		  ('solo',   'Solo Analyst', 'x', 'analista', true, true),
		  ('reader', 'Read Only',    'x', 'consulta', true, true);
		INSERT INTO grants (username, tenant_id) VALUES
		  ('multi','SIPGES/PRJ-SECHURA'), ('multi','ACME/NORTE'),
		  ('solo','SIPGES/PRJ-SECHURA'), ('reader','SIPGES/PRJ-SECHURA');
		INSERT INTO digital_alert_reviews (`+alertColumns+`) VALUES
		  ('SIPGES/PRJ-SECHURA','MGMT-AL-1','PRJ-SECHURA','2026-10-01T10:00:00.123Z','https://example.org/a1','web','x','`+sha+`','Alta',80,'m','[]','[]','[]',false,'Pendiente de verificación','',NULL),
		  ('SIPGES/PRJ-SECHURA','MGMT-AL-2','PRJ-SECHURA','2026-10-02T10:00:00Z','https://example.org/a2','rss','x','`+sha+`','Media',40,'m','[]','[]','[]',false,'Corroborado','','2026-10-03T08:30:00.5Z'),
		  ('SIPGES/PRJ-SECHURA','MGMT-AL-X','OTRO-PRJ','2026-10-04T10:00:00Z','https://example.org/ax','web','x','`+sha+`','Alta',90,'m','[]','[]','[]',false,'Pendiente de verificación','',NULL),
		  ('ACME/NORTE','MGMT-AL-N1','NORTE','2026-10-05T10:00:00Z','https://example.org/n1','web','x','`+sha+`','Baja',10,'m','[]','[]','[]',false,'Descartado','',NULL);
		INSERT INTO preventive_actions (tenant_id, id, project_id, alert_id, title, responsible, due_date,
		  description, status, progress, created_at, updated_at) VALUES
		  ('SIPGES/PRJ-SECHURA','MGMT-AC-1','PRJ-SECHURA','MGMT-AL-1','Mesa de diálogo','Equipo A','2020-01-10','','Pendiente',20,'2026-10-05T00:00:00Z','2026-10-06T07:08:09.999Z'),
		  ('SIPGES/PRJ-SECHURA','MGMT-AC-2','PRJ-SECHURA','MGMT-AL-1','=Revisar <acuerdos> & actas','Equipo B','2020-01-05','','En ejecución',50,'2026-10-05T00:00:00Z','2026-10-05T00:00:00Z'),
		  ('SIPGES/PRJ-SECHURA','MGMT-AC-3','PRJ-SECHURA','MGMT-AL-2','Informe','Equipo A','2099-12-31','','Completada',100,'2026-10-05T00:00:00Z','2026-10-05T00:00:00Z'),
		  ('SIPGES/PRJ-SECHURA','MGMT-AC-X','OTRO-PRJ','MGMT-AL-X','Ajena','Equipo X','2020-01-01','','Pendiente',0,'2026-10-05T00:00:00Z','2026-10-05T00:00:00Z'),
		  ('ACME/NORTE','MGMT-AC-N1','NORTE','MGMT-AL-N1','Norte','Equipo N','2020-01-01','','Pendiente',0,'2026-10-05T00:00:00Z','2026-10-05T00:00:00Z');
		INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking) VALUES
		  ('SIPGES/PRJ-SECHURA','Compromisos','MGMT-C-1','{"Responsable":"Comité","Estado":"Vencido","Plazo":"2020-02-01"}','2026-10-10Z','2026-10-10Z','interno'),
		  ('SIPGES/PRJ-SECHURA','Compromisos','MGMT-C-2','{"Responsable":7,"Estado":"Pendiente","Fecha_Limite":"2099-01-01"}','2026-10-09Z','2026-10-09Z','interno'),
		  ('SIPGES/PRJ-SECHURA','Compromisos','MGMT-C-R','{"Responsable":"Reservado","Estado":"VENCIDA"}','2026-10-11Z','2026-10-11Z','restringido'),
		  ('SIPGES/PRJ-SECHURA','Eventos','MGMT-E-1','{"Estado":"Vencido"}','2026-10-12Z','2026-10-12Z','interno'),
		  ('ACME/NORTE','Compromisos','MGMT-C-N1','{"Responsable":"Norte","Estado":"Vencido"}','2026-10-10Z','2026-10-10Z','interno');`); err != nil {
		return err
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
	if scratch == nil {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	pool, err := pgxpool.New(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	handler, err := app.NewHandler(pool, app.Options{
		Logger: slog.New(slog.DiscardHandler),
		Now:    func() time.Time { return t0 },
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv.URL
}

type reply struct {
	status int
	header http.Header
	body   string
}

func get(t *testing.T, base, path, user string, headers map[string]string) reply {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), http.MethodGet, base+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if user != "" {
		r.Header.Set("Cookie", "sipges_session="+tokens[user])
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return reply{res.StatusCode, res.Header, string(b)}
}

// sameJSON compares JSON by value (object key order is not part of JSON).
func sameJSON(t *testing.T, got reply, status int, want string) {
	t.Helper()
	if got.status != status {
		t.Fatalf("status %d, want %d: %s", got.status, status, got.body)
	}
	var g, w any
	if err := json.Unmarshal([]byte(got.body), &g); err != nil {
		t.Fatalf("body %q: %v", got.body, err)
	}
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(g, w) {
		t.Fatalf("got  %s\nwant %s", got.body, want)
	}
}

const limitations = `"methodology":"Indicadores descriptivos de registros por proyecto; las prioridades digitales no son probabilidades de conflicto.","limitations":["IRSA permanece independiente","Acceso restringido a usuarios autenticados con permiso sobre el proyecto activo","Compromisos vencidos contados únicamente cuando el estado lo indica expresamente","No hay verificación automática de contenido en redes sociales"]`

// overviewOf is the expected Sechura overview; commitments and their two counts depend on the
// account's clearance.
func overviewOf(registered, overdue int, commitments string) string {
	return `{"version":"2.8","project_id":"PRJ-SECHURA","generated_at":"2026-11-03T12:00:00Z",
	"metrics":{"digital_alerts":2,"high_priority_alerts":1,"pending_review":1,"total_actions":3,"active_actions":2,
	  "overdue_actions":2,"completed_actions":1,"completion_percent":33.3,"average_progress":56.7,
	  "registered_commitments":` + fmt.Sprint(registered) + `,"overdue_commitments_explicit":` + fmt.Sprint(overdue) + `},
	"alerts_by_level":{"Media":1,"Alta":1},
	"actions_by_status":{"En ejecución":1,"Pendiente":1,"Completada":1},
	"actions_by_responsible":[{"name":"Equipo A","total":2,"overdue":1},{"name":"Equipo B","total":1,"overdue":1}],
	"critical_actions":[
	  {"id":"MGMT-AC-2","alert_id":"MGMT-AL-1","title":"=Revisar <acuerdos> & actas","responsible":"Equipo B","due_date":"2020-01-05","status":"En ejecución","progress":50,"updated_at":"2026-10-05T00:00:00Z"},
	  {"id":"MGMT-AC-1","alert_id":"MGMT-AL-1","title":"Mesa de diálogo","responsible":"Equipo A","due_date":"2020-01-10","status":"Pendiente","progress":20,"updated_at":"2026-10-06T07:08:09Z"}],
	"recent_alerts":[
	  {"id":"MGMT-AL-2","created_at":"2026-10-02T10:00:00Z","source_url":"https://example.org/a2","source_type":"rss","level":"Media","score":40,"status":"Corroborado","reviewed_at":"2026-10-03T08:30:00Z"},
	  {"id":"MGMT-AL-1","created_at":"2026-10-01T10:00:00Z","source_url":"https://example.org/a1","source_type":"web","level":"Alta","score":80,"status":"Pendiente de verificación","reviewed_at":null}],
	"commitments":` + commitments + `,` + limitations + `}`
}

const (
	c1 = `{"id":"MGMT-C-1","responsible":"Comité","status":"Vencido","due_date":"2020-02-01"}`
	c2 = `{"id":"MGMT-C-2","responsible":"7","status":"Pendiente","due_date":"2099-01-01"}`
	cR = `{"id":"MGMT-C-R","responsible":"Reservado","status":"VENCIDA","due_date":""}`

	signIn = `{"detail":"Inicie sesión para acceder a SIPGES"}`
)

func TestOverviewOfTheScopeProject(t *testing.T) {
	base := start(t)
	got := get(t, base, "/system/management/overview", "solo", nil)
	sameJSON(t, got, http.StatusOK, overviewOf(3, 2, "["+cR+","+c1+","+c2+"]"))
	if got.header.Get("Content-Type") != "application/json" || strings.HasSuffix(got.body, "\n") ||
		!strings.Contains(got.body, "<acuerdos> & actas") {
		t.Fatalf("not c.json bytes: %q %q", got.header.Get("Content-Type"), got.body)
	}
}

func TestReadOnlyRoleNeverSeesRestrictedCommitments(t *testing.T) {
	base := start(t)
	sameJSON(t, get(t, base, "/system/management/overview", "reader", nil), http.StatusOK,
		overviewOf(2, 1, "["+c1+","+c2+"]"))
}

func TestOtherTenantsAndProjectsAreNeverCounted(t *testing.T) {
	base := start(t)
	// The same admin, scoped to Sechura, sees neither Norte's rows nor the other project's
	// rows stored under Sechura's tenant.
	sameJSON(t, get(t, base, "/system/management/overview", "multi", map[string]string{"X-SIPGES-Scope": "SIPGES/PRJ-SECHURA"}),
		http.StatusOK, overviewOf(3, 2, "["+cR+","+c1+","+c2+"]"))
	got := get(t, base, "/system/management/overview", "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
	var body struct {
		ProjectID string         `json:"project_id"`
		Metrics   map[string]any `json:"metrics"`
		Critical  []struct {
			ID string `json:"id"`
		} `json:"critical_actions"`
		Commitments []struct {
			ID string `json:"id"`
		} `json:"commitments"`
	}
	if err := json.Unmarshal([]byte(got.body), &body); err != nil || got.status != http.StatusOK {
		t.Fatalf("%d %s", got.status, got.body)
	}
	if body.ProjectID != "NORTE" || body.Metrics["digital_alerts"] != 1.0 || body.Metrics["total_actions"] != 1.0 ||
		len(body.Critical) != 1 || body.Critical[0].ID != "MGMT-AC-N1" ||
		len(body.Commitments) != 1 || body.Commitments[0].ID != "MGMT-C-N1" {
		t.Fatalf("Norte overview = %s", got.body)
	}
}

func TestRefusesRequestsWithoutSessionOrGrant(t *testing.T) {
	base := start(t)
	for _, path := range []string{"/system/management/overview", "/system/management/report.csv"} {
		got := get(t, base, path, "", nil)
		if got.status != http.StatusUnauthorized || got.body != signIn+"\n" && got.body != signIn {
			t.Fatalf("%s without a session: %d %s", path, got.status, got.body)
		}
		sameJSON(t, get(t, base, path, "solo", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"}), http.StatusForbidden,
			`{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["SIPGES/PRJ-SECHURA"]}`)
	}
}

func TestCSVReport(t *testing.T) {
	base := start(t)
	got := get(t, base, "/system/management/report.csv", "solo", nil)
	want := "\ufeffSIPGES RC 2.8,Resumen gerencial,PRJ-SECHURA,2026-11-03T12:00:00Z\r\n" +
		"Indicador,Valor\r\n" +
		"digital_alerts,2\r\nhigh_priority_alerts,1\r\npending_review,1\r\ntotal_actions,3\r\n" +
		"active_actions,2\r\noverdue_actions,2\r\ncompleted_actions,1\r\ncompletion_percent,33.3\r\n" +
		"average_progress,56.7\r\nregistered_commitments,3\r\noverdue_commitments_explicit,2\r\n" +
		"\r\n" +
		"Acciones críticas,Responsable,Plazo,Estado,Avance (%)\r\n" +
		"'=Revisar <acuerdos> & actas,Equipo B,2020-01-05,En ejecución,50\r\n" +
		"Mesa de diálogo,Equipo A,2020-01-10,Pendiente,20\r\n" +
		"\r\n" +
		"Nota metodológica,Indicadores descriptivos de registros por proyecto; las prioridades digitales no son probabilidades de conflicto.\r\n"
	if got.status != http.StatusOK || got.body != want {
		t.Fatalf("got %d %q\nwant %q", got.status, got.body, want)
	}
	if ct := got.header.Get("Content-Type"); ct != "text/csv; charset=utf-8" {
		t.Fatalf("Content-Type %q", ct)
	}
	if cd := got.header.Get("Content-Disposition"); cd != `attachment; filename="sipges_rc28_reporte_gerencial.csv"` {
		t.Fatalf("Content-Disposition %q", cd)
	}
}

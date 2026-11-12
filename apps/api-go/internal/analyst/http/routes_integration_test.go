//nolint:misspell // Spanish record fields, modules and messages, verbatim from the TypeScript API.
package http_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app/apitest"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// The analyst read routes against a migrated synthetic PostgreSQL, through the composed handler
// (session, project scope, role gate). Every account, project and record is synthetic.

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

// t0 is the synthetic "now": today is 2026-11-03.
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

// records is the same graph for both tenants, with each tenant's word in every title, so a
// cross-tenant read shows in the text.
func records(tenant, word string) string {
	row := func(module, id, payload, marking, updated string) string {
		return fmt.Sprintf("('%s','%s','%s','%s'::jsonb,'%s','2026-01-01T00:00:00Z','%s')", tenant, module, id,
			strings.ReplaceAll(payload, "WORD", word), marking, updated)
	}
	return `INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES ` +
		strings.Join([]string{
			row("Actores", "A-1", `{"Nombre_Actor/Organizacion":"Comunidad WORD","Posicion_Proyecto":"En contra"}`, "interno", "2026-10-01T00:00:00Z"),
			row("Eventos", "EV-1", `{"Descripcion_Hecho":"Asamblea WORD","Fecha":"2026-10-01","Actor_Principal":"comunidad WORD","Fuente_ID":"F-1"}`, "interno", "2026-10-02T00:00:00Z"),
			row("Fuentes", "F-1", `{"Archivo_Fuente":"Acta WORD"}`, "publico", "2026-10-03T00:00:00Z"),
			row("Fuentes", "F-2", `{"Archivo_Fuente":"Informe reservado WORD"}`, "restringido", "2026-10-04T00:00:00Z"),
			row("Alertas", "AL-1", `{"Causa":"Amenaza de paro WORD","Nivel_Preliminar":"Alta","Estado":"Abierta","Fecha":"2026-10-05"}`, "interno", "2026-10-05T00:00:00Z"),
			row("Alertas", "AL-2", `{"Causa":"Bloqueo WORD","Nivel_Preliminar":"Roja","Estado":"Abierta"}`, "interno", "2026-10-06T00:00:00Z"),
			row("Narrativas", "N-1", `{"Descripcion":"Radio local: la Comunidad WORD rechaza el proyecto","Fecha_Observacion":"2026-10-07"}`, "interno", "2026-10-07T00:00:00Z"),
			row("Compromisos", "C-1", `{"Descripcion":"Entrega de agua WORD","Actor/Entidad":"Comunidad WORD","Plazo":"2026-10-20","Estado":"Pendiente"}`, "interno", "2026-10-08T00:00:00Z"),
		}, ",\n") + `;
		INSERT INTO record_links (tenant_id, link_type, source_module, source_id, target_module, target_id, note, created_by, created_at)
		VALUES ('` + tenant + `','relacionado_con','Actores','A-1','Fuentes','F-2','','sistema','2026-10-01T00:00:00Z');`
}

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
	sechura := records("SIPGES/PRJ-SECHURA", "Norte") + `
		INSERT INTO proposal_decisions (tenant_id, fingerprint, subject_module, subject_id, kind, decision, decided_by, decided_at)
		VALUES ('SIPGES/PRJ-SECHURA','record:acciones:alertas/AL-2','alertas','AL-2','record','rejected','solo','2026-10-10T00:00:00Z');`
	if err := tenantRows(ctx, conn, "SIPGES/PRJ-SECHURA", sechura); err != nil {
		return fmt.Errorf("sechura: %w", err)
	}
	// Another tenant reuses every id: only RLS keeps it out of Sechura. Its AL-2 is not decided.
	if err := tenantRows(ctx, conn, "ACME/NORTE", records("ACME/NORTE", "Secreto")); err != nil {
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

// needsDatabase skips a test before it touches the scratch database, which exists only when
// dbtest.EnvAdminURL is set.
func needsDatabase(t *testing.T) {
	t.Helper()
	if scratch == nil {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
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

type briefing struct {
	Subject struct {
		Title string `json:"title"`
	} `json:"subject"`
	GeneratedAt string  `json:"generated_at"`
	Engine      string  `json:"engine"`
	Narrator    *string `json:"narrator"`
	Sections    []struct {
		Title     string `json:"title"`
		Sentences []struct {
			Text string `json:"text"`
			Refs []int  `json:"refs"`
		} `json:"sentences"`
	} `json:"sections"`
	Sources []struct {
		Module string `json:"module"`
		ID     string `json:"id"`
		Title  string `json:"title"`
	} `json:"sources"`
}

func (b briefing) texts() []string {
	var out []string
	for _, s := range b.Sections {
		for _, sentence := range s.Sentences {
			out = append(out, s.Title+" | "+sentence.Text)
		}
	}
	return out
}

func decode[T any](t *testing.T, body string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		t.Fatalf("%v: %s", err, body)
	}
	return v
}

const (
	signIn     = `{"detail":"Inicie sesión para acceder a SIPGES"}`
	outOfScope = `{"detail":"Proyecto fuera de alcance"}`
	choose     = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["ACME/NORTE","SIPGES/PRJ-SECHURA"]}`
	chooseSolo = `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["SIPGES/PRJ-SECHURA"]}`
	missing    = `{"detail":"Registro no encontrado"}`
	notFound   = `{"detail":"Not Found"}`
)

func TestBriefsTheRecordFromItsVisibleConnections(t *testing.T) {
	base := start(t)
	status, body := get(t, base, "/system/briefing?module=actores&id=A-1", "solo", nil)
	if status != http.StatusOK {
		t.Fatalf("%d %s", status, body)
	}
	b := decode[briefing](t, body)
	if b.Engine != "extractivo" || b.Narrator != nil || b.GeneratedAt != "2026-11-03T11:00:00Z" || b.Subject.Title != "Comunidad Norte" {
		t.Fatalf("header: %s", body)
	}
	want := []string{
		"Resumen | Actor «Comunidad Norte».",
		"Resumen | Posicion Proyecto: En contra.",
		"Red de vínculos | Tiene 3 vínculos con 3 registros.",
		"Red de vínculos | asume: 1 registro (1 inferido de los datos).",
		"Red de vínculos | está relacionado con: 1 registro.",
		"Red de vínculos | participa en: 1 registro (1 inferido de los datos).",
		"Red de vínculos | está relacionado con Fuente «Informe reservado Norte».",
		"Red de vínculos | participa en Evento «Asamblea Norte» (2026-10-01), vínculo inferido.",
		"Red de vínculos | asume Compromiso «Entrega de agua Norte», vínculo inferido.",
		"Cronología | 2026-10-01: Evento «Asamblea Norte».",
		"Señales de atención | Actor «Comunidad Norte» mantiene una posición En contra.",
		"Señales de atención | Compromiso «Entrega de agua Norte» venció el 2026-10-20 sin cerrarse.",
		"Señales de atención | 1 vínculo apunta a información restringida.",
	}
	if got := b.texts(); !slices.Equal(got, want) {
		t.Fatalf("sentences:\n%s", strings.Join(got, "\n"))
	}

	// The read-only clearance never sees the restricted source, nor counts it.
	status, body = get(t, base, "/system/briefing?module=actores&id=A-1", "reader", nil)
	if status != http.StatusOK || strings.Contains(body, "reservado") || strings.Contains(body, "restringida") ||
		!strings.Contains(body, `"Tiene 2 vínculos con 2 registros."`) {
		t.Fatalf("reader: %d %s", status, body)
	}
	status, body = get(t, base, "/system/briefing?module=fuentes&id=F-2", "reader", nil)
	expect(t, status, body, http.StatusNotFound, missing)
	status, body = get(t, base, "/system/briefing?module=fuentes&id=F-2", "solo", nil)
	if status != http.StatusOK {
		t.Fatalf("restricted subject, full clearance: %d %s", status, body)
	}
}

func TestNeverReadsAnotherTenantsRecords(t *testing.T) {
	base := start(t)
	for _, path := range []string{
		"/system/briefing?module=actores&id=A-1", "/system/briefing?module=eventos&id=EV-1",
		"/system/briefing/proposals?module=actores&id=A-1", "/system/briefing/proposals?module=alertas&id=AL-2",
	} {
		for _, user := range []string{"solo", "reader", "multi"} {
			headers := map[string]string{"X-SIPGES-Scope": "SIPGES/PRJ-SECHURA"}
			status, body := get(t, base, path, user, headers)
			if status != http.StatusOK || strings.Contains(body, "Secreto") {
				t.Fatalf("%s as %s: %d %s", path, user, status, body)
			}
		}
		// The two-project user reads the other tenant's copy there, and only there.
		status, body := get(t, base, path, "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
		if status != http.StatusOK || strings.Contains(body, "Norte»") || strings.Contains(body, "Comunidad Norte") {
			t.Fatalf("%s in ACME/NORTE: %d %s", path, status, body)
		}
	}
	// AL-2 was decided in Sechura only.
	_, sechura := get(t, base, "/system/briefing/proposals?module=alertas&id=AL-2", "solo", nil)
	_, norte := get(t, base, "/system/briefing/proposals?module=alertas&id=AL-2", "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
	if sechura != "[]" || !strings.Contains(norte, `"record:acciones:alertas/AL-2"`) {
		t.Fatalf("decisions crossed tenants:\n%s\n%s", sechura, norte)
	}
}

func TestProposesFollowUpsAndLinksReadFromText(t *testing.T) {
	base := start(t)
	status, body := get(t, base, "/system/briefing/proposals?module=alertas&id=AL-1", "solo", nil)
	expect(t, status, body, http.StatusOK, `[{"fingerprint":"record:acciones:alertas/AL-1","kind":"record",`+
		`"title":"Crear una acción de prevención para la alerta AL-1",`+
		`"reason":"La alerta sigue abierta con nivel Alta y ninguna acción la atiende.","link":null,`+
		`"record":{"module":"acciones","payload":{"Accion":"Atender alerta AL-1: Amenaza de paro Norte","Alerta_Asociada":"AL-1","Estado":"Pendiente","Plazo":"2026-11-10"}}}]`)

	status, body = get(t, base, "/system/briefing/proposals?module=actores&id=A-1", "solo", nil)
	expect(t, status, body, http.StatusOK, `[{"fingerprint":"link:difunde:actores/A-1:narrativas/N-1","kind":"link",`+
		`"title":"Vincular: Actor «Comunidad Norte» difunde Narrativa «Radio local: la Comunidad Norte rechaza el proyecto»",`+
		`"reason":"Narrativa N-1 lo menciona en Descripcion: «Radio local: la Comunidad Norte rechaza el proyecto»",`+
		`"link":{"link_type":"difunde","source":{"module":"actores","id":"A-1"},"target":{"module":"narrativas","id":"N-1"}},"record":null}]`)
}

func TestRefusesRequestsOutsideTheScope(t *testing.T) {
	base := start(t)
	for _, path := range []string{"/system/briefing?module=actores&id=A-1", "/system/briefing/proposals?module=actores&id=A-1"} {
		t.Run(path, func(t *testing.T) {
			status, body := get(t, base, path, "", nil)
			expect(t, status, body, http.StatusUnauthorized, signIn)
			status, body = get(t, base, path, "solo", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
			expect(t, status, body, http.StatusForbidden, chooseSolo)
			status, body = get(t, base, path+"&project_id=NORTE", "solo", nil)
			expect(t, status, body, http.StatusForbidden, outOfScope)
			status, body = get(t, base, path, "multi", nil)
			expect(t, status, body, http.StatusForbidden, choose)
		})
	}
	for _, path := range []string{"/system/briefing", "/system/briefing?module=actores", "/system/briefing?module=nada&id=A-1",
		"/system/briefing?module=actores&id=A-404", "/system/briefing/proposals?id=A-1",
		"/system/briefing?module=actores&id=" + strings.Repeat("x", 201), "/system/briefing?module=actores&id=A-1%00"} {
		status, body := get(t, base, path, "solo", nil)
		expect(t, status, body, http.StatusNotFound, missing)
	}
	status, body := get(t, base, "/system/briefing/?module=actores&id=A-1", "solo", nil)
	expect(t, status, body, http.StatusNotFound, notFound)
}

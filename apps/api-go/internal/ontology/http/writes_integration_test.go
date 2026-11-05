//nolint:misspell // Spanish record fields, labels and audit details, verbatim from the TypeScript API.
package http_test

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
)

// The ontology writes against the same synthetic database as the reads, through the composed
// handler, on records of their own (W1, W2, W3, WF1) so the read tests' rows never change. The
// expected bodies, audit rows and provenance rows are those sql-ontology-store.ts writes.

var writeRows sync.Once

// seedWrites adds, once, the write tests' records in both tenants (same ids), a link of the
// other tenant, and a coordinator account.
func seedWrites(t *testing.T) {
	t.Helper()
	writeRows.Do(func() {
		ctx := context.Background()
		conn, err := pgx.Connect(ctx, scratch.URL)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = conn.Close(ctx) }()
		for _, tenant := range []struct{ id, tag string }{{"SIPGES/PRJ-SECHURA", "PROPIA"}, {"ACME/NORTE", "AJENA"}} {
			sql := strings.NewReplacer("%T", tenant.id, "%G", tenant.tag).Replace(`
				INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES
				  ('%T', 'Actores', 'W1', '{"Nombre_Actor/Organizacion": "Gremio W1 %G", "Territorio": "Costa"}', 'interno', now(), '2025-01-01Z'),
				  ('%T', 'Actores', 'W2', '{"Nombre_Actor/Organizacion": "Gremio W2 %G"}', 'interno', now(), '2025-01-01Z'),
				  ('%T', 'Actores', 'W3', '{"Nombre_Actor/Organizacion": "Gremio W3 %G"}', 'interno', now(), '2025-01-01Z'),
				  ('%T', 'Fuentes', 'WF1', '{"Archivo_Fuente": "acta-w %G.pdf"}', 'interno', now(), '2025-01-01Z')`)
			if err := tenantRows(ctx, conn, tenant.id, sql); err != nil {
				t.Fatal(err)
			}
		}
		if err := tenantRows(ctx, conn, "ACME/NORTE", `
			INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES
			  ('ACME/NORTE', 'Actores', 'WX', '{"Nombre_Actor/Organizacion": "Solo AJENA"}', 'interno', now(), '2025-01-01Z');
			INSERT INTO record_links (tenant_id, link_type, source_module, source_id, target_module, target_id,
			  note, created_by, created_at, evidence_source_id) VALUES
			  ('ACME/NORTE', 'aliado_de', 'Actores', 'W1', 'Actores', 'W2', 'AJENA', 'tester', '2025-01-01Z', 'WF1')`); err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(ctx, `
			INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
			  ('coord', 'Coordinator', 'x', 'coordinador', true, true);
			INSERT INTO grants (username, tenant_id) VALUES ('coord', 'SIPGES/PRJ-SECHURA');`); err != nil {
			t.Fatal(err)
		}
		tokens["coord"] = strings.Repeat("c0", 32) // a well-formed synthetic token
		if _, err := conn.Exec(ctx, `INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, 'coord', $2)`,
			infrastructure.HashToken(tokens["coord"]), t0.Add(8*time.Hour)); err != nil {
			t.Fatal(err)
		}
	})
}

// send makes a same-origin request with a JSON body (when not empty) as user.
func send(t *testing.T, base, method, path, user, body string, headers map[string]string) (int, string) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	r, err := http.NewRequestWithContext(t.Context(), method, base+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", base)
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
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
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("%s %s: content-type %q", method, path, ct)
	}
	return res.StatusCode, strings.TrimSpace(string(b))
}

// owner queries the scratch database as its owner (row-level security does not apply).
func owner(t *testing.T, sql string, args ...any) []string {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	rows, err := conn.Query(t.Context(), sql, args...)
	if err != nil {
		t.Fatal(err)
	}
	out, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func expectRows(t *testing.T, got []string, want ...string) {
	t.Helper()
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("rows:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

const (
	sechura = "SIPGES/PRJ-SECHURA"
	ts      = "2026-11-03 11:00:00"
)

// audit lists the default project's audit rows of module for record ids, oldest first.
func audit(t *testing.T, module string, ids ...string) []string {
	t.Helper()
	return owner(t, `SELECT concat_ws(' | ', ts AT TIME ZONE 'UTC', module, record_id, action, detail) FROM audit
		WHERE tenant_id = $1 AND module = $2 AND record_id = ANY($3) ORDER BY id`, sechura, module, ids)
}

func linkBody(source, target, extra string) string {
	return `{"link_type":"aliado_de","source":{"module":"actores","id":"` + source + `"},"target":{"module":"actores","id":"` + target + `"}` + extra + `}`
}

func TestCreateLinkPersistsAuditsAndRefusesDuplicates(t *testing.T) {
	base := start(t)
	seedWrites(t)
	status, out := send(t, base, "POST", "/system/links", "solo", linkBody("W1", "W2", `,"note":"  Alianza　 ","evidence":{"module":"fuentes","id":"WF1"}`), nil)
	if status != http.StatusOK || !strings.HasPrefix(out, `{"ok":true,"id":`) {
		t.Fatalf("create: %d %s", status, out)
	}
	id := strings.TrimSuffix(strings.TrimPrefix(out, `{"ok":true,"id":`), "}")
	if _, err := strconv.Atoi(id); err != nil {
		t.Fatalf("id %q", id)
	}

	// The read proves the persisted effect: type, trimmed note, author, instant and evidence.
	status, out = get(t, base, "/system/links?module=actores&id=W1", "solo", nil)
	expect(t, status, out, http.StatusOK, `{"record":{"module":"actores","id":"W1","type_label":"Actor","title":"Gremio W1 PROPIA","date":null,"marking":"interno","fields":{"Territorio":"Costa"}},"links":[`+
		`{"edge":{"id":`+id+`,"link_type":"aliado_de","source":{"module":"actores","id":"W1"},"target":{"module":"actores","id":"W2"},"inferred":false,"via":null,"note":"Alianza","created_by":"solo","created_at":"2026-11-03T11:00:00Z",`+
		`"evidence":{"module":"fuentes","id":"WF1","type_label":"Fuente","title":"acta-w PROPIA.pdf","date":null,"marking":"interno","fields":{}},"evidence_status":"available"},`+
		`"direction":"out","label":"es aliado de","other":{"module":"actores","id":"W2","type_label":"Actor","title":"Gremio W2 PROPIA","date":null,"marking":"interno","fields":{}}}]}`)
	expectRows(t, audit(t, "Vinculos", id), ts+" | Vinculos | "+id+" | CREATE | Vínculo creado: Actores W1 es aliado de Actores W2")
	expectRows(t, owner(t, `SELECT concat_ws(' | ', coalesce(previous_source_id, '-'), next_source_id, actor, at AT TIME ZONE 'UTC')
		FROM link_evidence_history WHERE tenant_id = $1 AND link_id = $2::int ORDER BY id`, sechura, id),
		"- | WF1 | solo | 2026-11-03 11:00:00")

	// The same link again, also reversed (aliado_de is symmetric), is a duplicate; nothing more is audited.
	for _, again := range []string{linkBody("W1", "W2", ""), linkBody("W2", "W1", "")} {
		status, out = send(t, base, "POST", "/system/links", "solo", again, nil)
		expect(t, status, out, http.StatusConflict, `{"detail":"El vínculo ya existe"}`)
	}
	expectRows(t, audit(t, "Vinculos", id), ts+" | Vinculos | "+id+" | CREATE | Vínculo creado: Actores W1 es aliado de Actores W2")

	for _, c := range []struct {
		name, body string
		status     int
		detail     string
	}{
		{"unknown type", `{"link_type":"amigo_de","source":{"module":"actores","id":"W1"},"target":{"module":"actores","id":"W3"}}`, 422, "Tipo de vínculo no válido"},
		{"unknown object", `{"link_type":"aliado_de","source":{"module":"Actores","id":"W1"},"target":{"module":"actores","id":"W3"}}`, 422, "Tipo de objeto no válido"},
		{"self link", linkBody("W1", "W1", ""), 422, "Un registro no puede vincularse consigo mismo"},
		{"not allowed", `{"link_type":"participa_en","source":{"module":"actores","id":"W1"},"target":{"module":"actores","id":"W3"}}`, 422, "El tipo de vínculo no admite esos tipos de objeto"},
		{"missing end", linkBody("W1", "NOPE", ""), 404, "Registro no encontrado"},
		{"end only in another tenant", linkBody("W1", "WX", ""), 404, "Registro no encontrado"},
		{"missing evidence", linkBody("W1", "W3", `,"evidence":{"module":"fuentes","id":"NOPE"}`), 404, "Registro no encontrado"},
	} {
		status, out = send(t, base, "POST", "/system/links", "solo", c.body, nil)
		expect(t, status, out, c.status, `{"detail":"`+c.detail+`"}`)
	}
	status, out = send(t, base, "POST", "/system/links", "solo", `{"link_type":""}`, nil)
	expect(t, status, out, 422, `{"detail":[{"type":"too_small","loc":["body","link_type"],"msg":"Too small: expected string to have >=1 characters"},`+
		`{"type":"missing","loc":["body","source"],"msg":"Field required"},{"type":"missing","loc":["body","target"],"msg":"Field required"}]}`)
	expectRows(t, owner(t, `SELECT count(*)::text FROM record_links WHERE tenant_id = $1 AND source_id LIKE 'W%'`, sechura), "1")
}

func TestLinkEvidenceUpdatesAuditOnlyChanges(t *testing.T) {
	base := start(t)
	seedWrites(t)
	_, out := send(t, base, "POST", "/system/links", "solo", linkBody("W2", "W3", ""), nil)
	id := strings.TrimSuffix(strings.TrimPrefix(out, `{"ok":true,"id":`), "}")
	path := "/system/links/" + id + "/evidence"

	for range 2 { // the second time nothing changes, so nothing is audited
		status, out := send(t, base, "PUT", path, "solo", `{"evidence":{"module":"fuentes","id":"WF1"}}`, nil)
		expect(t, status, out, http.StatusOK, `{"ok":true}`)
	}
	status, out := send(t, base, "PUT", path, "solo", `{"evidence":null}`, nil)
	expect(t, status, out, http.StatusOK, `{"ok":true}`)
	expectRows(t, audit(t, "Vinculos", id),
		ts+" | Vinculos | "+id+" | CREATE | Vínculo creado: Actores W2 es aliado de Actores W3",
		ts+" | Vinculos | "+id+" | UPDATE | Fuente de evidencia vinculada",
		ts+" | Vinculos | "+id+" | UPDATE | Fuente de evidencia retirada")
	expectRows(t, owner(t, `SELECT concat_ws(' | ', coalesce(previous_source_id, '-'), coalesce(next_source_id, '-'), actor)
		FROM link_evidence_history WHERE tenant_id = $1 AND link_id = $2::int ORDER BY id`, sechura, id),
		"- | - | solo", "- | WF1 | solo", "WF1 | - | solo")
	status, out = get(t, base, "/system/links?module=actores&id=W3", "solo", nil)
	if status != http.StatusOK || !strings.Contains(out, `"evidence":null,"evidence_status":"undocumented"`) {
		t.Fatalf("read: %d %s", status, out)
	}

	other := owner(t, `SELECT id::text FROM record_links WHERE tenant_id = 'ACME/NORTE' AND source_id = 'W1'`)[0]
	for _, c := range []struct{ path, body string }{
		{"/system/links/" + other + "/evidence", `{"evidence":null}`}, // another tenant's link
		{path, `{"evidence":{"module":"fuentes","id":"NOPE"}}`},       // a source that does not exist
		{"/system/links/abc/evidence", `{"evidence":null}`},
		{"/system/links/1234567890/evidence", `{"evidence":null}`},
		{"/system/links/999999999/evidence", `{"evidence":null}`},
	} {
		status, out = send(t, base, "PUT", c.path, "solo", c.body, nil)
		expect(t, status, out, http.StatusNotFound, `{"detail":"Registro no encontrado"}`)
	}
	expectRows(t, owner(t, `SELECT evidence_source_id FROM record_links WHERE id = $1::int`, other), "WF1")
	// The body is validated before the id is read.
	status, out = send(t, base, "PUT", "/system/links/abc/evidence", "solo", `{}`, nil)
	expect(t, status, out, 422, `{"detail":[{"type":"missing","loc":["body","evidence"],"msg":"Field required"}]}`)
}

func TestMarkingHidesRecordsFromTheReadOnlyRoleAndIsAudited(t *testing.T) {
	base := start(t)
	seedWrites(t)
	raise := `{"module":"actores","id":"W3","marking":"restringido"}`
	for range 2 { // idempotent: the second time changes and audits nothing
		status, out := send(t, base, "PUT", "/system/marking", "solo", raise, nil)
		expect(t, status, out, http.StatusOK, `{"ok":true,"marking":"restringido"}`)
	}
	expectRows(t, audit(t, "Actores", "W3"), ts+" | Actores | W3 | CLASSIFY | Clasificación: interno → restringido")

	// The read-only role stops seeing it, in every read; the analyst still does.
	status, out := get(t, base, "/system/links?module=actores&id=W3", "reader", nil)
	expect(t, status, out, http.StatusNotFound, `{"detail":"Registro no encontrado"}`)
	status, out = get(t, base, "/system/search?q=W3", "reader", nil)
	expect(t, status, out, http.StatusOK, `{"query":"W3","hits":[]}`)
	status, out = send(t, base, "POST", "/system/graph/neighbourhood", "reader", `{"seeds":[{"module":"actores","id":"W3"}],"hops":[["aliado_de"]]}`, nil)
	expect(t, status, out, http.StatusOK, `{"seeds":[],"nodes":[],"edges":[],"truncated":false}`)
	status, out = get(t, base, "/system/links?module=actores&id=W3", "solo", nil)
	if status != http.StatusOK || !strings.Contains(out, `"marking":"restringido"`) {
		t.Fatalf("analyst read: %d %s", status, out)
	}

	// Who may not change a marking: the read-only role and the coordinator (role gate), nor
	// anyone without a session; nor for a record of another tenant.
	lower := `{"module":"actores","id":"W3","marking":"publico"}`
	status, out = send(t, base, "PUT", "/system/marking", "reader", lower, nil)
	expect(t, status, out, http.StatusForbidden, `{"detail":"Rol de consulta: solo lectura"}`)
	status, out = send(t, base, "PUT", "/system/marking", "coord", lower, nil)
	expect(t, status, out, http.StatusForbidden, `{"detail":"Operación restringida para coordinador"}`)
	status, out = send(t, base, "PUT", "/system/marking", "", lower, nil)
	expect(t, status, out, http.StatusUnauthorized, `{"detail":"Inicie sesión para acceder a SIPGES"}`)
	for _, body := range []string{
		`{"module":"actores","id":"WX","marking":"restringido"}`,   // only in ACME/NORTE
		`{"module":"Actores","id":"W3","marking":"publico"}`,       // stored name, not a slug
		`{"module":"actores","id":"NOPE","marking":"restringido"}`, // no such record
	} {
		status, out = send(t, base, "PUT", "/system/marking", "solo", body, nil)
		expect(t, status, out, http.StatusNotFound, `{"detail":"Registro no encontrado"}`)
	}
	status, out = send(t, base, "PUT", "/system/marking", "multi", `{"module":"actores","id":"W3","marking":"publico","project_id":"NORTE"}`, nil)
	if status != http.StatusForbidden {
		t.Fatalf("body naming another project: %d %s", status, out)
	}
	expectRows(t, owner(t, `SELECT tenant_id || ' ' || marking FROM module_records WHERE id IN ('W3', 'WX') ORDER BY tenant_id, id`),
		"ACME/NORTE interno", "ACME/NORTE interno", sechura+" restringido")

	// An administrator lowers it again, and the read-only role sees it once more.
	status, out = send(t, base, "PUT", "/system/marking", "multi", lower, map[string]string{"X-SIPGES-Scope": sechura})
	expect(t, status, out, http.StatusOK, `{"ok":true,"marking":"publico"}`)
	expectRows(t, audit(t, "Actores", "W3"),
		ts+" | Actores | W3 | CLASSIFY | Clasificación: interno → restringido",
		ts+" | Actores | W3 | CLASSIFY | Clasificación: restringido → publico")
	status, out = get(t, base, "/system/links?module=actores&id=W3", "reader", nil)
	if status != http.StatusOK || !strings.Contains(out, `"marking":"publico"`) {
		t.Fatalf("read-only after lowering: %d %s", status, out)
	}
	status, out = send(t, base, "PUT", "/system/marking", "solo", `{"module":"actores","id":"W3","marking":"secreto"}`, nil)
	expect(t, status, out, 422, `{"detail":[{"type":"invalid_value","loc":["body","marking"],"msg":"Invalid option: expected one of \"publico\"|\"interno\"|\"restringido\""}]}`)
}

func TestDeleteLinkDeletesOnlyTheTenantsLinkAndAuditsIt(t *testing.T) {
	base := start(t)
	seedWrites(t)
	_, out := send(t, base, "POST", "/system/links", "solo", `{"link_type":"en_conflicto_con","source":{"module":"actores","id":"W3"},"target":{"module":"actores","id":"W1"}}`, nil)
	id := strings.TrimSuffix(strings.TrimPrefix(out, `{"ok":true,"id":`), "}")
	status, out := send(t, base, "DELETE", "/system/links/"+id, "reader", "", nil)
	expect(t, status, out, http.StatusForbidden, `{"detail":"Rol de consulta: solo lectura"}`)
	status, out = send(t, base, "DELETE", "/system/links/"+id, "solo", "", nil)
	expect(t, status, out, http.StatusOK, `{"ok":true}`)
	status, out = send(t, base, "DELETE", "/system/links/"+id, "solo", "", nil)
	expect(t, status, out, http.StatusNotFound, `{"detail":"Vínculo no encontrado"}`)
	expectRows(t, audit(t, "Vinculos", id),
		ts+" | Vinculos | "+id+" | CREATE | Vínculo creado: Actores W3 está en conflicto con Actores W1",
		ts+" | Vinculos | "+id+" | DELETE | Vínculo eliminado: Actores W3 en_conflicto_con Actores W1")
	expectRows(t, owner(t, `SELECT count(*)::text FROM record_links WHERE id = $1::int`, id), "0")

	other := owner(t, `SELECT id::text FROM record_links WHERE tenant_id = 'ACME/NORTE' AND source_id = 'W1'`)[0]
	for _, path := range []string{"/system/links/" + other, "/system/links/abc", "/system/links/-1", "/system/links/1234567890"} {
		status, out = send(t, base, "DELETE", path, "solo", "", nil)
		expect(t, status, out, http.StatusNotFound, `{"detail":"Vínculo no encontrado"}`)
	}
	expectRows(t, owner(t, `SELECT count(*)::text FROM record_links WHERE id = $1::int`, other), "1")
	expectRows(t, owner(t, `SELECT count(*)::text FROM audit WHERE tenant_id = 'ACME/NORTE' AND module = 'Vinculos'`), "0")
}

func TestNeighbourhoodFollowsTheHopsOfTheVisibleSeeds(t *testing.T) {
	base := start(t)
	seedWrites(t)
	nb := `{"seeds":[{"module":"eventos","id":"E1"},{"module":"eventos","id":"E1"},{"module":"nada","id":"E1"},{"module":"alertas","id":"R1"}],"hops":[["origina"]],"fields":["Fecha"]}`
	status, out := send(t, base, "POST", "/system/graph/neighbourhood", "solo", nb, nil)
	expect(t, status, out, http.StatusOK, `{"seeds":[{"module":"eventos","id":"E1"},{"module":"eventos","id":"E1"},{"module":"alertas","id":"R1"}],"nodes":[`+
		`{"module":"alertas","id":"R1","type_label":"Alerta","title":"Alerta clave PROPIA","date":"2026-02-04","marking":"restringido","fields":{"Fecha":"2026-02-04"}},`+
		`{"module":"eventos","id":"E1","type_label":"Evento","title":"Reunión clave PROPIA","date":"2026-02-03","marking":"interno","fields":{"Fecha":"2026-02-03"}}],"edges":[`+origin+`],"truncated":false}`)
	// The read-only role may send it (a read-only POST) and never sees the restricted alert.
	status, out = send(t, base, "POST", "/system/graph/neighbourhood", "reader", nb, nil)
	expect(t, status, out, http.StatusOK, `{"seeds":[{"module":"eventos","id":"E1"},{"module":"eventos","id":"E1"}],"nodes":[`+
		`{"module":"eventos","id":"E1","type_label":"Evento","title":"Reunión clave PROPIA","date":"2026-02-03","marking":"interno","fields":{"Fecha":"2026-02-03"}}],"edges":[],"truncated":false}`)
	status, out = send(t, base, "POST", "/system/graph/neighbourhood", "solo", `{"seeds":[{"module":"eventos","id":"E1"}],"hops":[["origina"],["amigo_de","x"]]}`, nil)
	expect(t, status, out, 422, `{"detail":"Tipo de vínculo no válido: amigo_de"}`)
	status, out = send(t, base, "POST", "/system/graph/neighbourhood", "multi", nb, map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
	if status != http.StatusOK || strings.Contains(out, "PROPIA") || !strings.Contains(out, "AJENA") {
		t.Fatalf("other tenant: %d %s", status, out)
	}
}

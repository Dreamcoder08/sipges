package app_test

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Ported from apps/api/test/tenancy/export-http.test.ts, on the tables and values where the
// JSON of postgres.js differs from a plain Go encoding: bigint as text, jsonb read by JSON.parse, timestamps cut to milliseconds. The other project of each
// test holds a row in every table the first one uses, under a marker no export may show.

const foreignMarker = "AJENO-NO-EXPORTAR"

func exportBody(project, data string) string {
	company, name, _ := strings.Cut(project, "/")
	return `{"format":"sipges.tenant-export","version":1,` +
		`"scope":{"company_id":"` + company + `","project_id":"` + name + `"},` +
		`"exported_at":"` + t0.Add(-time.Hour).Format("2006-01-02T15:04:05") + `Z","data":{` + data + `}}`
}

const emptyAfterModuleRecords = `"audit":[],"attachments":[],"document_review":[],"digital_alert_reviews":[],` +
	`"preventive_actions":[],"preventive_action_log":[],"record_versions":[],"record_links":[],` +
	`"automation_rules":[],"automation_runs":[],"notifications":[],"source_import_settings":[],"project_settings":[]`

func (f *tenancyFixture) exportAs(t *testing.T, user, project string) reply {
	t.Helper()
	return f.s.do(t, req{path: "/system/export", user: user, headers: map[string]string{"X-SIPGES-Scope": project}})
}

func TestExportsOnlyTheCallersProjectAsTypeScriptWritesIt(t *testing.T) {
	f := newTenancyFixture(t, "exp1")
	own := f.project(t, "EXP1", "PROPIO")
	other := f.project(t, "EXP1", "OTRO")
	admin := f.account(t, "admin", "admin", own, other)

	f.exec(t, `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking) VALUES
	  ($1, 'Eventos', 'r2', '{"b":1.50,"10":"diez","2":"dos","a":{"z":1e400,"y":[1,2.0,null,true]},"html":"<a&b> "}',
	   '2026-03-04 05:06:07.123456+00', '2026-03-04 05:06:07+00', 'restringido'),
	  ($1, 'Eventos', 'r1', '{}', '2026-03-04 05:06:07+00', 'infinity', 'interno'),
	  ($2, 'Eventos', 'r3', '{"nota":"`+foreignMarker+`"}', now(), now(), 'interno')`, own, other)
	f.exec(t, `INSERT INTO attachments (tenant_id, id, storage_key, original_name, content_type, size_bytes, sha256,
	    linked_module, record_module, linked_record_id, document_type, author, verification, notes, project_id,
	    project_name, created_at) VALUES
	  ($1, 'a1', 'k', 'n.pdf', 'application/pdf', 9007199254740993, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Eventos', 'Eventos', 'r1', 'd', 'x', 'v', '',
	   'PROPIO', 'p', '2026-03-04 05:06:07+00'),
	  ($2, 'a2', 'k2', '`+foreignMarker+`', 'application/pdf', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Eventos', 'Eventos', 'r3', 'd', 'x', 'v', '',
	   'OTRO', 'p', now())`, own, other)
	f.exec(t, `INSERT INTO automation_rules (id, tenant_id, name, enabled, trigger_module, trigger_actions, conditions,
	    actions, created_by, created_at, updated_at) OVERRIDING SYSTEM VALUE VALUES
	  (910001, $1, 'Regla', true, '*', '{CREATE,"UP DATE",NULL}', '[]', '[]', 'x', '2026-03-04 05:06:07+00', '2026-03-04 05:06:07.5+00'),
	  (910002, $2, '`+foreignMarker+`', false, '*', '{DELETE}', '[]', '[]', 'x', now(), now())`, own, other)

	// Their ids depend on what other tests inserted; the module_records above show the same values.
	f.exec(t, `DELETE FROM record_versions WHERE tenant_id = $1`, own)

	got := f.exportAs(t, admin, own)
	want := exportBody(own,
		`"module_records":[`+
			`{"tenant_id":"`+own+`","module":"Eventos","id":"r1","payload":{},"created_at":"2026-03-04T05:06:07.000Z","updated_at":null,"marking":"interno"},`+
			`{"tenant_id":"`+own+`","module":"Eventos","id":"r2","payload":{"2":"dos","10":"diez","a":{"y":[1,2,null,true],"z":null},"b":1.5,"html":"<a&b>`+" "+`"},`+
			`"created_at":"2026-03-04T05:06:07.123Z","updated_at":"2026-03-04T05:06:07.000Z","marking":"restringido"}],`+
			`"audit":[],`+
			`"attachments":[{"tenant_id":"`+own+`","id":"a1","storage_key":"k","original_name":"n.pdf","content_type":"application/pdf",`+
			`"size_bytes":"9007199254740993","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","linked_module":"Eventos","record_module":"Eventos","linked_record_id":"r1",`+
			`"document_type":"d","author":"x","verification":"v","notes":"","project_id":"PROPIO","project_name":"p",`+
			`"created_at":"2026-03-04T05:06:07.000Z"}],`+
			`"document_review":[],"digital_alert_reviews":[],"preventive_actions":[],"preventive_action_log":[],"record_versions":[],"record_links":[],`+
			`"automation_rules":[{"id":910001,"tenant_id":"`+own+`","name":"Regla","enabled":true,"trigger_module":"*",`+
			`"trigger_actions":["CREATE","UP DATE",null],"conditions":[],"actions":[],"created_by":"x",`+
			`"created_at":"2026-03-04T05:06:07.000Z","updated_at":"2026-03-04T05:06:07.500Z"}],`+
			`"automation_runs":[],"notifications":[],"source_import_settings":[],"project_settings":[]`)
	expect(t, got, http.StatusOK, want)
	if strings.Contains(got.body, foreignMarker) || strings.Contains(got.body, other) {
		t.Fatalf("the export shows another project: %s", got.body)
	}

	foreign := f.exportAs(t, admin, other)
	if foreign.status != http.StatusOK || !strings.Contains(foreign.body, foreignMarker) || strings.Contains(foreign.body, own) {
		t.Fatalf("the other project's export: %d %s", foreign.status, foreign.body)
	}
}

func TestExportAnswersAsADownloadThatIsNeverCached(t *testing.T) {
	f := newTenancyFixture(t, "exp2")
	own := f.project(t, "EXP2", "PROPIO")
	admin := f.account(t, "admin", "admin", own)

	r, err := http.NewRequestWithContext(t.Context(), http.MethodGet, f.s.url+"/system/export", http.NoBody)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Cookie", "sipges_session="+tokens[admin])
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("got %d %s", res.StatusCode, body)
	}
	for header, want := range map[string]string{
		"Content-Type":        "application/json; charset=UTF-8",
		"Content-Disposition": `attachment; filename="sipges-tenant.json"`,
		"Cache-Control":       "no-store",
	} {
		if got := res.Header.Get(header); got != want {
			t.Errorf("%s: got %q, want %q", header, got, want)
		}
	}
	if want := exportBody(own, `"module_records":[],`+emptyAfterModuleRecords); string(body) != want {
		t.Fatalf("got %s\nwant %s", body, want)
	}
	if !json.Valid(body) {
		t.Fatalf("not JSON: %s", body)
	}
}

func TestExportRefusesWhoMayNotReadTheProject(t *testing.T) {
	f := newTenancyFixture(t, "exp3")
	own := f.project(t, "EXP3", "PROPIO")
	other := f.project(t, "EXP3", "OTRO")
	admin := f.account(t, "admin", "admin", own)
	analyst := f.account(t, "analista", "analista", own)
	reader := f.account(t, "consulta", "consulta", own)

	expect(t, f.s.do(t, req{path: "/system/export"}), http.StatusUnauthorized, signIn)
	for _, user := range []string{analyst, reader} {
		expect(t, f.exportAs(t, user, own), http.StatusForbidden, `{"detail":"Requiere rol administrador"}`)
	}
	expect(t, f.exportAs(t, admin, other), http.StatusForbidden,
		`{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["`+own+`"]}`)
	expect(t, f.s.do(t, req{path: "/system/export?project_id=OTRO", user: admin}), http.StatusForbidden, `{"detail":"Proyecto fuera de alcance"}`)
}

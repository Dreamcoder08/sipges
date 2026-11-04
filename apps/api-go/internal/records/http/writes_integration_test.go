package http_test

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/infrastructure"
)

// The write routes against the migrated synthetic PostgreSQL, through the composed handler:
// what each write leaves in module_records, audit and record_versions (the trigger), inside the
// resolved tenant only. They use Compromisos and Alertas, which the read tests above never list.

func send(t *testing.T, base, method, path, user string, headers map[string]string, body string) (int, string) {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), method, base+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", base)
	r.Header.Set("Content-Type", "application/json")
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
	// The gates' errors end in a newline (json.Encoder); the parity runner compares JSON values.
	return res.StatusCode, strings.TrimSuffix(string(b), "\n")
}

// rows reads one query as superuser (no RLS), each row as its columns joined by " | ".
func rows(t *testing.T, sql string, args ...any) []string {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(t.Context()) }()
	result, err := conn.Query(t.Context(), sql, args...)
	if err != nil {
		t.Fatal(err)
	}
	out, err := pgx.CollectRows(result, func(row pgx.CollectableRow) (string, error) {
		values, err := row.Values()
		parts := make([]string, len(values))
		for i, v := range values {
			if at, ok := v.(time.Time); ok {
				v = at.UTC().Format(time.RFC3339Nano)
			}
			parts[i] = fmt.Sprint(v)
		}
		return strings.Join(parts, " | "), err
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func same(t *testing.T, label string, got, want []string) {
	t.Helper()
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("%s\n got  %q\n want %q", label, got, want)
	}
}

const stamp = "2026-11-03T11:00:00Z" // t0, the handler's clock

func record(t *testing.T, tenant, module, id string) []string {
	return rows(t, `SELECT payload::text, marking, created_at, updated_at FROM module_records
		WHERE tenant_id = $1 AND module = $2 AND id = $3`, tenant, module, id)
}

func audits(t *testing.T, tenant, module string, ids ...string) []string {
	return rows(t, `SELECT coalesce(record_id, '<null>'), action, detail, ts FROM audit
		WHERE tenant_id = $1 AND module = $2 AND (record_id = ANY($3) OR record_id IS NULL AND $4) ORDER BY id`,
		tenant, module, ids, len(ids) == 0)
}

func versions(t *testing.T, tenant, module, id string) []string {
	return rows(t, `SELECT operation, coalesce(payload::text, '<null>'), actor FROM record_versions
		WHERE tenant_id = $1 AND module = $2 AND record_id = $3 ORDER BY id`, tenant, module, id)
}

const sechura = "SIPGES/PRJ-SECHURA"

func TestCreateReplaceDeleteWriteRecordAuditAndHistoryInOneTenant(t *testing.T) {
	base := start(t)
	status, body := send(t, base, "POST", "/api/compromisos", "solo", nil, `{"payload":{"ID_Compromiso":"W-1","Texto":"uno","n":1.50}}`)
	expect(t, "create", status, body, 200, `{"ok":true,"id":"W-1"}`)
	same(t, "created row", record(t, sechura, "Compromisos", "W-1"),
		[]string{`{"n": 1.5, "Texto": "uno", "Proyecto_ID": "PRJ-SECHURA", "ID_Compromiso": "W-1"} | interno | ` + stamp + ` | ` + stamp})
	same(t, "create audit", audits(t, sechura, "Compromisos", "W-1"),
		[]string{"W-1 | CREATE | Registro creado desde prototipo V0.2 | " + stamp})
	same(t, "create version", versions(t, sechura, "Compromisos", "W-1"),
		[]string{`CREATE | {"n": 1.5, "Texto": "uno", "Proyecto_ID": "PRJ-SECHURA", "ID_Compromiso": "W-1"} | solo`})

	// The same id again: the next candidate is `W-1-<4 hex>`.
	status, body = send(t, base, "POST", "/api/compromisos", "solo", nil, `{"payload":{"ID_Compromiso":"W-1"}}`)
	if status != 200 || !strings.HasPrefix(body, `{"ok":true,"id":"W-1-`) || len(body) != len(`{"ok":true,"id":"W-1-ABCD"}`) {
		t.Errorf("collision: %d %s", status, body)
	}

	status, body = send(t, base, "PUT", "/api/compromisos/W-1", "solo", nil, `{"payload":{"Texto":"dos"}}`)
	expect(t, "replace", status, body, 200, `{"ok":true}`)
	same(t, "replaced row", record(t, sechura, "Compromisos", "W-1"),
		[]string{`{"Texto": "dos", "Proyecto_ID": "PRJ-SECHURA"} | interno | ` + stamp + ` | ` + stamp})
	// An identical replace is audited but leaves no version (the trigger skips it).
	status, body = send(t, base, "PUT", "/api/compromisos/W-1", "multi", map[string]string{"X-SIPGES-Scope": sechura}, `{"payload":{"Texto":"dos","Proyecto_ID":"PRJ-SECHURA"}}`)
	expect(t, "same replace", status, body, 200, `{"ok":true}`)

	status, body = send(t, base, "DELETE", "/api/compromisos/W-1", "solo", nil, "")
	expect(t, "delete", status, body, 200, `{"ok":true}`)
	same(t, "deleted row", record(t, sechura, "Compromisos", "W-1"), nil)
	status, body = send(t, base, "DELETE", "/api/compromisos/W-1", "solo", nil, "")
	expect(t, "delete again", status, body, 404, missing)
	status, body = send(t, base, "PUT", "/api/compromisos/W-1", "solo", nil, `{"payload":{}}`)
	expect(t, "replace deleted", status, body, 404, missing)

	same(t, "audit trail", audits(t, sechura, "Compromisos", "W-1"), []string{
		"W-1 | CREATE | Registro creado desde prototipo V0.2 | " + stamp,
		"W-1 | UPDATE | Registro actualizado | " + stamp,
		"W-1 | UPDATE | Registro actualizado | " + stamp,
		"W-1 | DELETE | Registro eliminado | " + stamp,
	})
	same(t, "history", versions(t, sechura, "Compromisos", "W-1"), []string{
		`CREATE | {"n": 1.5, "Texto": "uno", "Proyecto_ID": "PRJ-SECHURA", "ID_Compromiso": "W-1"} | solo`,
		`UPDATE | {"Texto": "dos", "Proyecto_ID": "PRJ-SECHURA"} | solo`,
		`DELETE | <null> | solo`,
	})
	status, body = get(t, base, "/api/compromisos/W-1/history", "solo", nil)
	if status != 200 || !strings.Contains(body, `"operation":"DELETE","actor":"solo"`) {
		t.Errorf("history route: %d %s", status, body)
	}
}

func TestWritesNeverReachAnotherTenant(t *testing.T) {
	base := start(t)
	norteHeaders := map[string]string{"X-SIPGES-Scope": "ACME/NORTE"}
	status, body := send(t, base, "POST", "/api/alertas", "multi", norteHeaders, `{"payload":{"ID_Alerta":"W-AL","Texto":"norte"}}`)
	expect(t, "create in norte", status, body, 200, `{"ok":true,"id":"W-AL"}`)
	// The same id in Sechura is no collision: the key holds the tenant.
	status, body = send(t, base, "POST", "/api/alertas", "solo", nil, `{"payload":{"ID_Alerta":"W-AL","Texto":"sechura"}}`)
	expect(t, "create in sechura", status, body, 200, `{"ok":true,"id":"W-AL"}`)
	status, body = send(t, base, "POST", "/api/alertas", "solo", nil, `{"payload":{"ID_Alerta":"W-NORTE-SOLO"}}`)
	expect(t, "create", status, body, 200, `{"ok":true,"id":"W-NORTE-SOLO"}`)
	status, body = send(t, base, "DELETE", "/api/alertas/W-NORTE-SOLO", "multi", norteHeaders, "")
	expect(t, "delete from norte a sechura id", status, body, 404, missing)
	status, body = send(t, base, "PUT", "/api/alertas/W-NORTE-SOLO", "multi", norteHeaders, `{"payload":{"x":1}}`)
	expect(t, "replace from norte a sechura id", status, body, 404, missing)
	status, body = send(t, base, "PUT", "/api/alertas/W-AL", "solo", nil, `{"payload":{"Texto":"sechura 2"}}`)
	expect(t, "replace in sechura", status, body, 200, `{"ok":true}`)

	same(t, "norte row", record(t, "ACME/NORTE", "Alertas", "W-AL"),
		[]string{`{"Texto": "norte", "ID_Alerta": "W-AL", "Proyecto_ID": "NORTE"} | interno | ` + stamp + ` | ` + stamp})
	same(t, "sechura row", record(t, sechura, "Alertas", "W-AL"),
		[]string{`{"Texto": "sechura 2", "Proyecto_ID": "PRJ-SECHURA"} | interno | ` + stamp + ` | ` + stamp})
	same(t, "norte audit", audits(t, "ACME/NORTE", "Alertas", "W-AL", "W-NORTE-SOLO"),
		[]string{"W-AL | CREATE | Registro creado desde prototipo V0.2 | " + stamp})
	same(t, "sechura row kept", record(t, sechura, "Alertas", "W-NORTE-SOLO"),
		[]string{`{"ID_Alerta": "W-NORTE-SOLO", "Proyecto_ID": "PRJ-SECHURA"} | interno | ` + stamp + ` | ` + stamp})

	// Writing into another project through the body, and the role gates, before any route.
	for _, c := range []struct {
		method, path, user string
		headers            map[string]string
		body               string
		status             int
		answer             string
	}{
		{"POST", "/api/alertas", "solo", nil, `{"payload":{"Proyecto_ID":"NORTE"}}`, 403, `{"detail":"No se permite escribir en otro proyecto"}`},
		{"POST", "/api/alertas", "solo", nil, `{"project_id":"NORTE","payload":{}}`, 403, `{"detail":"No se permite escribir en otro proyecto"}`},
		{"POST", "/api/alertas", "solo", norteHeaders, `{"payload":{}}`, 403, `{"detail":"Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project","projects":["SIPGES/PRJ-SECHURA"]}`},
		{"POST", "/api/alertas", "reader", nil, `{"payload":{}}`, 403, `{"detail":"Rol de consulta: solo lectura"}`},
		{"DELETE", "/api/alertas/W-AL", "reader", nil, "", 403, `{"detail":"Rol de consulta: solo lectura"}`},
		{"POST", "/system/import/alertas", "reader", nil, `{"rows":[]}`, 403, `{"detail":"Rol de consulta: solo lectura"}`},
		{"POST", "/api/usuarios", "solo", nil, `{"payload":{}}`, 403, `{"detail":"Acceso administrativo requerido"}`},
		{"POST", "/api/proyectos", "solo", nil, `{"payload":{}}`, 403, `{"detail":"Solo el administrador puede gestionar proyectos"}`},
		{"POST", "/api/alertas", "", nil, `{"payload":{}}`, 401, `{"detail":"Inicie sesión para acceder a SIPGES"}`},
	} {
		status, body := send(t, base, c.method, c.path, c.user, c.headers, c.body)
		expect(t, c.method+" "+c.path+" "+c.user, status, body, c.status, c.answer)
	}
	same(t, "nothing else in alertas", rows(t, `SELECT tenant_id || ' ' || id FROM module_records WHERE module = 'Alertas' ORDER BY 1`),
		[]string{"ACME/NORTE W-AL", sechura + " W-AL", sechura + " W-NORTE-SOLO"})
}

func TestAFailedWriteLeavesNothing(t *testing.T) {
	base := start(t)
	// jsonb refuses a lone surrogate: the insert fails, 500, nothing is stored or audited.
	status, body := send(t, base, "POST", "/api/compromisos", "solo", nil, `{"payload":{"ID_Compromiso":"W-BAD","x":"\ud800"}}`)
	expect(t, "lone surrogate", status, body, 500, `{"detail":"Internal Server Error"}`)
	same(t, "no row", record(t, sechura, "Compromisos", "W-BAD"), nil)
	// The import's audit detail cannot hold NUL: the merged rows roll back with it.
	status, body = send(t, base, "POST", "/system/import/compromisos", "solo", nil,
		`{"rows":[{"ID_Compromiso":"W-NUL"}],"dry_run":false,"source":"a\u0000b"}`)
	expect(t, "NUL source", status, body, 500, `{"detail":"Internal Server Error"}`)
	same(t, "no imported row", record(t, sechura, "Compromisos", "W-NUL"), nil)
	same(t, "no audit", audits(t, sechura, "Compromisos", "W-BAD", "W-NUL"), nil)
}

func TestImportMergesInChunksWithOneAuditEntry(t *testing.T) {
	base := start(t)
	status, body := send(t, base, "POST", "/api/acciones", "solo", nil, `{"payload":{"ID_Accion":"IMP-7","Previo":"se queda","n":"viejo"}}`)
	expect(t, "seed", status, body, 200, `{"ok":true,"id":"IMP-7"}`)
	var b strings.Builder
	b.WriteString(`{"dry_run":false,"source":"  hoja sintética.xlsx  ","rows":[`)
	for i := range 1201 {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `{"ID_Accion":"IMP-%d","n":" %d ","vacío":"  "}`, i, i)
	}
	b.WriteString("]}")
	dry := strings.Replace(b.String(), `"dry_run":false`, `"dry_run":true`, 1)
	status, body = send(t, base, "POST", "/system/import/acciones", "solo", nil, dry)
	expect(t, "dry run", status, body, 200, `{"applied":false,"created":1200,"updated":1,"problems":[]}`)
	status, body = send(t, base, "POST", "/system/import/acciones", "solo", nil, b.String())
	expect(t, "import", status, body, 200, `{"applied":true,"created":1200,"updated":1,"problems":[]}`)

	same(t, "merged row", record(t, sechura, "Acciones", "IMP-7"),
		[]string{`{"n": "7", "Previo": "se queda", "ID_Accion": "IMP-7", "Proyecto_ID": "PRJ-SECHURA"} | interno | ` + stamp + ` | ` + stamp})
	same(t, "a created row", record(t, sechura, "Acciones", "IMP-1200"),
		[]string{`{"n": "1200", "ID_Accion": "IMP-1200", "Proyecto_ID": "PRJ-SECHURA"} | interno | ` + stamp + ` | ` + stamp})
	same(t, "count", rows(t, `SELECT count(*) FROM module_records WHERE tenant_id = $1 AND module = 'Acciones'`, sechura), []string{"1201"})
	same(t, "one import entry", audits(t, sechura, "Acciones"),
		[]string{"<null> | IMPORT | Importación de 1201 filas desde hoja sintética.xlsx | " + stamp})
	same(t, "merged history", versions(t, sechura, "Acciones", "IMP-7"), []string{
		`CREATE | {"n": "viejo", "Previo": "se queda", "ID_Accion": "IMP-7", "Proyecto_ID": "PRJ-SECHURA"} | solo`,
		`UPDATE | {"n": "7", "Previo": "se queda", "ID_Accion": "IMP-7", "Proyecto_ID": "PRJ-SECHURA"} | solo`,
	})
	same(t, "versions", rows(t, `SELECT operation, count(*) FROM record_versions WHERE tenant_id = $1 AND module = 'Acciones' GROUP BY 1 ORDER BY 1`, sechura),
		[]string{"CREATE | 1201", "UPDATE | 1"})

	// A batch with a problem writes nothing.
	status, body = send(t, base, "POST", "/system/import/acciones", "solo", nil, `{"dry_run":false,"rows":[{"ID_Accion":"IMP-NUEVO"},{"Proyecto_ID":"NORTE"}]}`)
	expect(t, "refused batch", status, body, 422, `{"applied":false,"created":1,"updated":0,"problems":[{"row":2,"message":"Proyecto_ID: Proyecto_ID no corresponde al proyecto activo"}]}`)
	same(t, "not imported", record(t, sechura, "Acciones", "IMP-NUEVO"), nil)
}

// importBatch folds repeated ids before writing (no route sends them: planImport refuses them).
func TestImportBatchFoldsRepeatedIDs(t *testing.T) {
	start(t)
	pool, err := pgxpool.New(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	payload := func(text string) *domain.Object {
		o, err := domain.ParseObject([]byte(text))
		if err != nil {
			t.Fatal(err)
		}
		return o
	}
	store := infrastructure.Records{DB: pool}
	at := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	created, updated, err := store.ImportBatch(t.Context(), sechura, "Dialogos", []domain.ImportItem{
		{Row: 1, ID: "F-1", Payload: payload(`{"a":"1","b":"1"}`)},
		{Row: 2, ID: "F-2", Payload: payload(`{"a":"2"}`)},
		{Row: 3, ID: "F-1", Payload: payload(`{"b":"3","c":"3"}`)},
	}, application.AuditNote{Action: "IMPORT", Detail: "plegado"}, at)
	if err != nil || created != 2 || updated != 1 {
		t.Fatalf("import: %d created, %d updated, %v", created, updated, err)
	}
	same(t, "folded row", rows(t, `SELECT payload::text FROM module_records WHERE tenant_id = $1 AND module = 'Dialogos' AND id = 'F-1'`, sechura),
		[]string{`{"a": "1", "b": "3", "c": "3"}`})
	same(t, "one version each", rows(t, `SELECT record_id, operation, actor FROM record_versions WHERE tenant_id = $1 AND module = 'Dialogos' ORDER BY id`, sechura),
		[]string{"F-1 | CREATE | sistema", "F-2 | CREATE | sistema"})
}

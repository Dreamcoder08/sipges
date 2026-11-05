//nolint:misspell // Spanish themes, fields and messages, verbatim from the TypeScript API.
package http_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
)

// The review writes (import, single and bulk decisions) through the composed handler against
// the synthetic PostgreSQL: the persisted rows, the audit trail, the records an approval
// creates once, and another tenant that reuses the same ids left untouched. The tenants
// LAB/PW and LAB/PV and their accounts exist only in this test.

const labSHA = "cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34"

func seedWrites(t *testing.T) {
	t.Helper()
	ctx := t.Context()
	conn, err := pgx.Connect(ctx, scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	if _, err := conn.Exec(ctx, `
		INSERT INTO tenants (company_id, project_id, label) VALUES ('LAB','PW','PW'), ('LAB','PV','PV');
		INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
		  ('writer', 'Equipo Revisor', 'x', 'analista', true, true),
		  ('peeker', '', 'x', 'consulta', true, true);
		INSERT INTO grants (username, tenant_id) VALUES ('writer','LAB/PW'), ('peeker','LAB/PW');`); err != nil {
		t.Fatal(err)
	}
	row := func(tenant, id, theme string) string {
		return finding(tenant, id, "PW", theme, "pendiente", "", "", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z")
	}
	w := strings.Join([]string{
		row("LAB/PW", "W1", "Demandas e intereses"),
		row("LAB/PW", "W2", "Tema libre"),
		row("LAB/PW", "W3", "Demandas e intereses"),
		row("LAB/PW", "W4", "Territorio y ambiente"),
	}, ",")
	if err := tenantRows(ctx, conn, "LAB/PW", strings.ReplaceAll(insertFindings+w, sha, labSHA)); err != nil {
		t.Fatal(err)
	}
	// The other tenant reuses the ids and the project id: only RLS keeps it out.
	v := strings.Join([]string{row("LAB/PV", "W1", "Demandas e intereses"), row("LAB/PV", "W2", "Tema libre")}, ",")
	if err := tenantRows(ctx, conn, "LAB/PV", strings.ReplaceAll(insertFindings+v, sha, labSHA)); err != nil {
		t.Fatal(err)
	}
	batch := &pgx.Batch{}
	for _, user := range []string{"writer", "peeker"} {
		var b [32]byte
		_, _ = rand.Read(b[:])
		tokens[user] = hex.EncodeToString(b[:])
		batch.Queue(`INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)`,
			infrastructure.HashToken(tokens[user]), user, t0.Add(8*time.Hour))
	}
	if err := conn.SendBatch(ctx, batch).Close(); err != nil {
		t.Fatal(err)
	}
}

func send(t *testing.T, base, method, path, user, body string) (int, string) {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), method, base+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Cookie", "sipges_session="+tokens[user])
	r.Header.Set("Origin", base)
	r.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, strings.TrimSpace(string(b))
}

// asTenant runs a query entered as tenant, as the API does, and returns its rows as text.
func asTenant(t *testing.T, tenant, sql string) []string {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	tx, err := conn.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(t.Context(), `SELECT set_config('app.tenant_id', $1, true), set_config('role', 'sipges_tenant', true)`, tenant); err != nil {
		t.Fatal(err)
	}
	rows, err := tx.Query(t.Context(), sql)
	if err != nil {
		t.Fatal(err)
	}
	out, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func same(t *testing.T, what string, got []string, want ...string) {
	t.Helper()
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("%s:\n got %q\nwant %q", what, got, want)
	}
}

func compact(t *testing.T, s string) string {
	t.Helper()
	var b bytes.Buffer
	if err := json.Compact(&b, []byte(s)); err != nil {
		t.Fatalf("%v: %s", err, s)
	}
	return b.String()
}

func TestReviewWritesPersistOnceInsideTheTenant(t *testing.T) {
	base := start(t)
	seedWrites(t)
	const statuses = `SELECT id || ' ' || status || ' ' || reviewer || ' ' || note FROM document_review ORDER BY id`
	const records = `SELECT module || ' ' || id || ' ' || (payload->>'Revision_Documental_ID') FROM module_records WHERE id LIKE 'REV-W%' ORDER BY module, id`
	const audit = `SELECT module || ' ' || coalesce(record_id, '-') || ' ' || action || ' ' || detail FROM audit ORDER BY id`

	// A read-only account cannot decide.
	if status, body := send(t, base, http.MethodPatch, "/system/document-lab/review/W1", "peeker", `{"status":"descartado"}`); status != 403 {
		t.Fatalf("consulta decided: %d %s", status, body)
	}

	// Approving creates the record once, in the theme's module, and audits both writes.
	status, body := send(t, base, http.MethodPatch, "/system/document-lab/review/W1", "writer", `{"status":"aceptado_para_revision","reviewer":"Equipo","note":"Ver acta"}`)
	expect(t, status, body, 200, `{"ok":true,"id":"W1","status":"aceptado_para_revision","record":{"module":"demandas","id":"REV-W1","created":true}}`)
	status, body = send(t, base, http.MethodPatch, "/system/document-lab/review/W1", "writer", `{"status":"aceptado_para_revision","reviewer":"Equipo"}`)
	expect(t, status, body, 200, `{"ok":true,"id":"W1","status":"aceptado_para_revision","record":{"module":"demandas","id":"REV-W1","created":false}}`)
	status, body = send(t, base, http.MethodPatch, "/system/document-lab/review/W9", "writer", `{"status":"descartado"}`)
	expect(t, status, body, 404, `{"detail":"Hallazgo no encontrado"}`)
	status, body = send(t, base, http.MethodPatch, "/system/document-lab/review/W2", "writer", `{"status":"corroborado_documentalmente","note":"  "}`)
	expect(t, status, body, 422, `{"detail":"La corroboración requiere nota sobre evidencia contrastada"}`)

	// A dry run counts and writes nothing.
	status, body = send(t, base, http.MethodPost, "/system/document-lab/review/bulk", "writer", `{"theme":"Demandas e intereses","status":"aceptado_para_revision","dry_run":true}`)
	expect(t, status, body, 200, compact(t, `{"ok":true,"dry_run":true,"decided":1,"skipped":0,"remaining":0,
		"modules":[{"module":"demandas","label":"Demandas","nuevos":1,"ya_existentes":0}],"problems":[],"records_created":1}`))

	// Explicit ids: only pending items of this tenant are decided, each with its record.
	status, body = send(t, base, http.MethodPost, "/system/document-lab/review/bulk", "writer", `{"ids":["W2","W3","W1","W9"],"status":"aceptado_para_revision"}`)
	expect(t, status, body, 200, compact(t, `{"ok":true,"dry_run":false,"decided":2,"skipped":2,"remaining":0,
		"modules":[{"module":"demandas","label":"Demandas","nuevos":1,"ya_existentes":0},{"module":"hechos","label":"Hechos compartidos","nuevos":1,"ya_existentes":0}],
		"problems":[],"records_created":2}`))
	// A filter by document: the last pending item, discarded, creates no record.
	status, body = send(t, base, http.MethodPost, "/system/document-lab/review/bulk", "writer", `{"source_sha256":"`+labSHA+`","status":"descartado","note":"Duplicado"}`)
	expect(t, status, body, 200, `{"ok":true,"dry_run":false,"decided":1,"skipped":0,"remaining":0,"modules":[],"problems":[],"records_created":0}`)

	same(t, "LAB/PW findings", asTenant(t, "LAB/PW", statuses),
		"W1 aceptado_para_revision Equipo ",
		"W2 aceptado_para_revision Equipo Revisor ",
		"W3 aceptado_para_revision Equipo Revisor ",
		"W4 descartado Equipo Revisor Duplicado")
	same(t, "LAB/PW records", asTenant(t, "LAB/PW", records),
		"Demandas REV-W1 W1", "Demandas REV-W3 W3", "Hechos_Compartidos REV-W2 W2")
	same(t, "LAB/PW audit", asTenant(t, "LAB/PW", audit),
		"Laboratorio_Documental W1 REVIEW aceptado_para_revision | Equipo",
		"Demandas REV-W1 CREATE Registro creado desde la bandeja de revisión documental",
		"Laboratorio_Documental W1 REVIEW aceptado_para_revision | Equipo",
		"Laboratorio_Documental W2 REVIEW aceptado_para_revision | Equipo Revisor",
		"Laboratorio_Documental W3 REVIEW aceptado_para_revision | Equipo Revisor",
		"Demandas REV-W3 CREATE Registro creado desde la bandeja de revisión documental",
		"Hechos_Compartidos REV-W2 CREATE Registro creado desde la bandeja de revisión documental",
		"Laboratorio_Documental W4 REVIEW descartado | Equipo Revisor")
	// The other tenant, with the same ids and project id, is untouched.
	same(t, "LAB/PV findings", asTenant(t, "LAB/PV", statuses), "W1 pendiente  ", "W2 pendiente  ")
	same(t, "LAB/PV records", asTenant(t, "LAB/PV", records))
	same(t, "LAB/PV audit", asTenant(t, "LAB/PV", audit))

	// Import stores excerpts once: a repeated excerpt and a re-import add nothing.
	batch := `{"filename":"acta.pdf","sha256":"` + labSHA + `","items":[
		{"tema":"Demandas e intereses","fragmento":"La comunidad pidió empleo.","ubicacion":"Página 1","accion_sugerida":"Contrastar"},
		{"tema":"Demandas e intereses","fragmento":"La comunidad pidió empleo.","ubicacion":"Página 1"},
		{"tema":"Tema libre","fragmento":"Otro extracto.","ubicacion":"Página 2"},
		{"tema":"Sin ubicación","fragmento":"x"}]}`
	status, body = send(t, base, http.MethodPost, "/system/document-lab/review/import", "writer", batch)
	expect(t, status, body, 200, `{"ok":true,"new_items":2,"message":"Sólo se guardaron extractos de revisión, no los archivos originales."}`)
	status, body = send(t, base, http.MethodPost, "/system/document-lab/review/import", "writer", batch)
	expect(t, status, body, 200, `{"ok":true,"new_items":0,"message":"Sólo se guardaron extractos de revisión, no los archivos originales."}`)
	same(t, "imported", asTenant(t, "LAB/PW", `SELECT project_id || ' ' || theme || ' ' || excerpt || ' ' || location || ' ' || status || ' ' || action || ' ' || length(id)::text
		FROM document_review WHERE id NOT LIKE 'W%' ORDER BY excerpt`),
		"PW Demandas e intereses La comunidad pidió empleo. Página 1 pendiente Contrastar 32",
		"PW Tema libre Otro extracto. Página 2 pendiente  32")
	same(t, "LAB/PV after import", asTenant(t, "LAB/PV", `SELECT id FROM document_review ORDER BY id`), "W1", "W2")
	if status, body := send(t, base, http.MethodPost, "/system/document-lab/review/import", "peeker", batch); status != 403 {
		t.Fatalf("consulta imported: %d %s", status, body)
	}
}

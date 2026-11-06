package http_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// PARITY/OTRO's alert names SIPGES's project on purpose: only row-level security keeps it out.
const riskRows = `
INSERT INTO digital_alert_reviews (tenant_id, id, project_id, created_at, source_url, source_type, excerpt, sha256,
  level, status, territory, score, method, themes, signals, suggestions, semantic_active, analyst_note) VALUES
  ('SIPGES/PRJ-SECHURA', 'CR-1', 'PRJ-SECHURA', '2026-10-02T08:00:00Z', 'https://example.org/1', 'sintetico', 'x', repeat('a', 64),
   'Alta', 'Pendiente de verificación', 'Territorio propio', 1, 'r', '[]', '[]', '[]', false, ''),
  ('PARITY/OTRO', 'CR-2', 'PRJ-SECHURA', '2026-10-02T08:00:00Z', 'https://example.org/2', 'sintetico', 'x', repeat('a', 64),
   'Alta', 'Pendiente de verificación', 'Territorio AJENA', 1, 'r', '[]', '[]', '[]', false, '');
INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking) VALUES
  ('SIPGES/PRJ-SECHURA', 'Alertas', 'CR-A', '{"Territorio":"Zona reservada","Nivel_Preliminar":"Rojo","Estado":"Activa","Fecha":"2026-10-01"}',
   '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'restringido');`

const removeRiskRows = `DELETE FROM digital_alert_reviews WHERE id IN ('CR-1', 'CR-2'); DELETE FROM module_records WHERE id = 'CR-A';`

func riskDatabase(t *testing.T, sql string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	if _, err := conn.Exec(ctx, sql); err != nil {
		t.Fatal(err)
	}
}

func TestConflictRiskReadsOnlyTheScopeAndItsClearance(t *testing.T) {
	base := start(t)
	riskDatabase(t, riskRows)
	t.Cleanup(func() { riskDatabase(t, removeRiskRows) })
	path := "/system/conflict-risk"

	status, body := get(t, base, path, "solo", nil)
	if status != http.StatusOK || !strings.Contains(body, "Territorio propio") || !strings.Contains(body, "Zona reservada") {
		t.Fatalf("%d %s", status, body)
	}
	if strings.Contains(body, "AJENA") {
		t.Fatalf("another project's rows reached the prediction: %s", body)
	}
	status, body = get(t, base, path, "reader", nil)
	if status != http.StatusOK || !strings.Contains(body, "Territorio propio") || strings.Contains(body, "Zona reservada") {
		t.Fatalf("%d %s", status, body)
	}
	status, body = get(t, base, path, "", nil)
	expect(t, status, body, http.StatusUnauthorized, signIn)
	status, body = get(t, base, path, "solo", map[string]string{"X-SIPGES-Scope": "PARITY/OTRO"})
	expect(t, status, body, http.StatusForbidden, chooseSolo)
	status, body = get(t, base, path+"?project_id=OTRO", "solo", nil)
	expect(t, status, body, http.StatusForbidden, outOfScope)
}

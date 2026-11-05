package http_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
)

const alerts = "/system/intelligence/territorial-alerts"

type alertAnswer struct {
	ID           string          `json:"id"`
	Status       string          `json:"status"`
	Outcome      string          `json:"outcome"`
	Territory    *string         `json:"territory"`
	SourceRecord json.RawMessage `json:"source_record"`
	Analysis     struct {
		Version string `json:"version"`
	} `json:"analysis"`
	IRSAModified bool   `json:"irsa_modified"`
	Notice       string `json:"notice"`
}

func create(t *testing.T, base, body string) alertAnswer {
	t.Helper()
	code, text := send(t, base, http.MethodPost, alerts, "solo", body, nil)
	if code != http.StatusOK {
		t.Fatalf("%d %s", code, text)
	}
	var out alertAnswer
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { removeAlert(t, out.ID) })
	return out
}

// removeAlert keeps the inbox the read tests of this package compare exactly.
func removeAlert(t *testing.T, id string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	if _, err := conn.Exec(ctx, `DELETE FROM digital_alert_reviews WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
}

func alertAudit(t *testing.T, id string) []string {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	rows, err := conn.Query(t.Context(),
		`SELECT module || '|' || action || '|' || detail || '|' || event_payload::text FROM audit WHERE record_id = $1`, id)
	if err != nil {
		t.Fatal(err)
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	return found
}

func TestCreatingAnAlertStoresItWithItsAuditRow(t *testing.T) {
	var calls atomic.Int32
	t.Setenv("SIPGES_OLLAMA_URL", embedderServer(t, http.StatusOK, &calls).URL)
	srv := start(t)
	out := create(t, srv, `{"text":"Texto sintético de agua uno","mode":"rules","territory":" Caserío ","analyst_note":"Nota","source_url":"https://example.org/uno","source_type":"Documento"}`)
	if !strings.HasPrefix(out.ID, "DIG-") || len(out.ID) != 16 || out.ID != strings.ToUpper(out.ID) {
		t.Fatalf("id = %q", out.ID)
	}
	if out.Status != "Pendiente de verificación" || out.Outcome != "created" || out.Territory == nil || *out.Territory != "Caserío" ||
		string(out.SourceRecord) != "null" || out.Analysis.Version != "2.5" || out.IRSAModified ||
		out.Notice != "La puntuación es prioridad de revisión, no riesgo social cuantificado." {
		t.Fatalf("%+v", out)
	}
	code, stored := get(t, srv, alerts+"/"+out.ID, "solo", nil)
	for _, want := range []string{`"analyst_note":"Nota"`, `"source_type":"Documento"`, `"territory":"Caserío"`, `"semantic_active":false`} {
		if code != http.StatusOK || !strings.Contains(stored, want) {
			t.Fatalf("%d, %q missing from %s", code, want, stored)
		}
	}
	rows := alertAudit(t, out.ID)
	if len(rows) != 1 || !strings.HasPrefix(rows[0], "InteligenciaDigital|CREATE|Señal registrada; IRSA intacto|") ||
		!strings.Contains(rows[0], `"status": "Pendiente de verificación"`) {
		t.Fatalf("audit = %q", rows)
	}
	if calls.Load() != 0 {
		t.Fatal("rules mode reached the embedder")
	}
}

func TestTheSameSignalWithinADayIsADuplicate(t *testing.T) {
	var calls atomic.Int32
	t.Setenv("SIPGES_OLLAMA_URL", embedderServer(t, http.StatusOK, &calls).URL)
	srv := start(t)
	const body = `{"text":"Texto sintético repetido","mode":"rules"}`
	first := create(t, srv, body)
	second := create(t, srv, body)
	if second.ID != first.ID || second.Outcome != "duplicate" || second.Analysis.Version != "2.5" {
		t.Fatalf("%+v", second)
	}
	if rows := alertAudit(t, first.ID); len(rows) != 1 {
		t.Fatalf("audit = %q", rows)
	}
	other := create(t, srv, `{"text":"Texto sintético repetido","mode":"rules","territory":"Otro"}`)
	if other.ID == first.ID || other.Outcome != "created" {
		t.Fatalf("%+v", other)
	}
}

func TestConcurrentSameSignalsCreateOneAlert(t *testing.T) {
	var calls atomic.Int32
	t.Setenv("SIPGES_OLLAMA_URL", embedderServer(t, http.StatusOK, &calls).URL)
	srv := start(t)
	var (
		wg  sync.WaitGroup
		mu  sync.Mutex
		ids = map[string]int{}
	)
	for range 8 {
		wg.Go(func() {
			out := create(t, srv, `{"text":"Texto sintético concurrente","mode":"rules"}`)
			mu.Lock()
			defer mu.Unlock()
			ids[out.ID]++
		})
	}
	wg.Wait()
	if len(ids) != 1 {
		t.Fatalf("ids = %v", ids)
	}
}

func TestTheDedupKeyIsTheOneTypeScriptWrites(t *testing.T) {
	var calls atomic.Int32
	t.Setenv("SIPGES_OLLAMA_URL", embedderServer(t, http.StatusOK, &calls).URL)
	srv := start(t)
	// sha256 of JSON.stringify(["<sha>","https://example.org/k","Documento","a\" b",null,null])
	// is checked in the SQL below; JSON.stringify leaves U+2028 alone, and escapes the quote.
	create(t, srv, `{"text":"Texto sintético de clave","mode":"rules","source_url":"https://example.org/k","source_type":"Documento","territory":"a\" b"}`)
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	var found int
	err = conn.QueryRow(t.Context(), `SELECT count(*) FROM digital_signal_dedup_locks d JOIN digital_alert_reviews a
		ON a.tenant_id = d.tenant_id AND d.dedup_key = encode(sha256(convert_to(
		  '["' || a.sha256 || '","https://example.org/k","Documento","a\"' || U&'\2028' || 'b",null,null]', 'UTF8')), 'hex')
		WHERE a.source_url = 'https://example.org/k'`).Scan(&found)
	if err != nil {
		t.Fatal(err)
	}
	if found != 1 {
		t.Fatalf("matching keys = %d", found)
	}
}

func TestAlertRefusals(t *testing.T) {
	var calls atomic.Int32
	t.Setenv("SIPGES_OLLAMA_URL", embedderServer(t, http.StatusBadGateway, &calls).URL)
	srv := start(t)
	cases := []struct {
		name, body string
		status     int
		want       string
	}{
		{"source type", `{"text":"t","source_type":"Rumor"}`, 422, `{"detail":"Tipo de fuente inválido"}`},
		{"mode", `{"text":"t","mode":"x"}`, 422, `{"detail":"Modo inválido"}`},
		{"unavailable", `{"text":"t","mode":"semantic"}`, 503, `{"detail":"Modelo local no disponible. Instale Ollama, descargue el modelo configurado o seleccione análisis por reglas."}`},
		{
			"territory too long", fmt.Sprintf(`{"text":"t","territory":%q}`, strings.Repeat("x", 501)), 422,
			`{"detail":[{"type":"too_big","loc":["body","territory"],"msg":"Too big: expected string to have <=500 characters"}]}`,
		},
		{
			"territory a number", `{"text":"t","territory":1}`, 422,
			`{"detail":[{"type":"invalid_type","loc":["body","territory"],"msg":"Invalid input: expected string, received number"}]}`,
		},
	}
	for _, c := range cases {
		code, body := send(t, srv, http.MethodPost, alerts, "solo", c.body, nil)
		if code != c.status || strings.TrimSpace(body) != c.want {
			t.Errorf("%s: %d %s", c.name, code, body)
		}
	}
	if code, _ := send(t, srv, http.MethodPost, alerts, "reader", `{"text":"t","mode":"rules"}`, nil); code != http.StatusForbidden {
		t.Errorf("read-only role: %d", code)
	}
}

func TestAnAlertStaysInItsProject(t *testing.T) {
	var calls atomic.Int32
	t.Setenv("SIPGES_OLLAMA_URL", embedderServer(t, http.StatusOK, &calls).URL)
	srv := start(t)
	out := create(t, srv, `{"text":"Texto sintético del proyecto","mode":"rules"}`)
	code, _ := get(t, srv, alerts+"/"+out.ID, "multi", map[string]string{"X-SIPGES-Scope": "ACME/NORTE"})
	if code != http.StatusNotFound {
		t.Fatalf("another tenant reads it: %d", code)
	}
}

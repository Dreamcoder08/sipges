//nolint:misspell // Spanish notices, verbatim from the TypeScript API.
package http_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
)

const failedNotice = "El resumen asistido no estuvo disponible; se muestra el informe extractivo."

// messagesDouble is a synthetic Messages API; no real provider is ever contacted here.
type messagesDouble struct {
	mu   sync.Mutex
	seen []string
}

var firstMark = regexp.MustCompile(`\[[0-9]+\]`)

func (m *messagesDouble) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var body struct {
		Messages []struct {
			Content string `json:"content"`
		} `json:"messages"`
	}
	_ = json.Unmarshal(raw, &body)
	content := body.Messages[0].Content
	m.mu.Lock()
	m.seen = append(m.seen, content)
	m.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"id":"msg","type":"message","role":"assistant","model":"m","stop_reason":"end_turn",`+
		`"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1},`+
		`"content":[{"type":"text","text":"Resumen sintético `+firstMark.FindString(content)+`."}]}`)
}

func (m *messagesDouble) texts() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return strings.Join(m.seen, "\n")
}

func withNarrator(t *testing.T) (*messagesDouble, string) {
	t.Helper()
	double := &messagesDouble{}
	srv := httptest.NewServer(double)
	t.Cleanup(srv.Close)
	t.Setenv("ANTHROPIC_BASE_URL", srv.URL)
	t.Setenv("ANTHROPIC_API_KEY", "synthetic-test-value")
	t.Setenv("SIPGES_ANALYST_PROVIDER", "anthropic")
	t.Setenv("SIPGES_ANALYST_MODEL", "claude-synthetic-1")
	t.Setenv("SIPGES_DATA_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", 32))))
	return double, start(t)
}

func setExternalAI(t *testing.T, enabled bool) {
	t.Helper()
	needsDatabase(t)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	value := `{"externalAi":{"enabled":false}}`
	if enabled {
		value = `{"externalAi":{"enabled":true}}`
	}
	if _, err := conn.Exec(ctx, `INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at)
		VALUES ('SIPGES/PRJ-SECHURA', $1::jsonb, 'prueba', now())
		ON CONFLICT (tenant_id) DO UPDATE SET settings = EXCLUDED.settings`, value); err != nil {
		t.Fatal(err)
	}
}

type assistedBriefing struct {
	Engine    string  `json:"engine"`
	Narrator  *string `json:"narrator"`
	Notice    *string `json:"notice"`
	Narrative *struct {
		Text string `json:"text"`
		Refs []int  `json:"refs"`
	} `json:"narrative"`
}

const actorBriefing = "/system/briefing?module=actores&id=A-1"

func TestTheNarratorWritesTheBriefingOnceTheSwitchIsOn(t *testing.T) {
	setExternalAI(t, true)
	t.Cleanup(func() { setExternalAI(t, false) })
	double, base := withNarrator(t)
	code, body := get(t, base, actorBriefing, "solo", nil)
	if code != http.StatusOK {
		t.Fatalf("%d %s", code, body)
	}
	got := decode[assistedBriefing](t, body)
	if got.Engine != "asistido" || got.Notice != nil || got.Narrator == nil || *got.Narrator != "claude:claude-synthetic-1" {
		t.Fatalf("%s", body)
	}
	if got.Narrative == nil || len(got.Narrative.Refs) != 1 || !strings.HasPrefix(got.Narrative.Text, "Resumen sintético [") {
		t.Fatalf("%s", body)
	}
	sent := double.texts()
	if !strings.HasPrefix(sent, "<informe>\n") {
		t.Fatalf("sent %q", sent)
	}
	for _, leak := range []string{"Comunidad PROPIA", "Posicion", "En contra", "reservado", "F-2"} {
		if strings.Contains(sent, leak) {
			t.Errorf("%q reached the model: %q", leak, sent)
		}
	}
}

func TestTheNarratorGetsNothingWhileTheSwitchIsOff(t *testing.T) {
	double, base := withNarrator(t)
	code, body := get(t, base, actorBriefing, "solo", nil)
	got := decode[assistedBriefing](t, body)
	if code != http.StatusOK || got.Engine != "extractivo" || got.Notice == nil || *got.Notice != failedNotice {
		t.Fatalf("%d %s", code, body)
	}
	if double.texts() != "" {
		t.Fatalf("sent %q", double.texts())
	}
}

func TestARestrictedRecordIsNeverNarrated(t *testing.T) {
	setExternalAI(t, true)
	t.Cleanup(func() { setExternalAI(t, false) })
	double, base := withNarrator(t)
	code, body := get(t, base, "/system/briefing?module=fuentes&id=F-2", "solo", nil)
	got := decode[assistedBriefing](t, body)
	want := "El registro está restringido; el resumen asistido no se genera para información restringida."
	if code != http.StatusOK || got.Engine != "extractivo" || got.Notice == nil || *got.Notice != want {
		t.Fatalf("%d %s", code, body)
	}
	if double.texts() != "" {
		t.Fatalf("sent %q", double.texts())
	}
}

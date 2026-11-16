package app_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
)

// The Inicio analyst end to end (odd/tasks/agentic-analyst.md S2): real router, session, RLS and
// egress guard, with a scripted OpenAI-compatible model on loopback that keeps every request.

type scriptedModel struct {
	mu     sync.Mutex
	steps  []string
	bodies []string
}

func (f *scriptedModel) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bodies = append(f.bodies, string(b))
	step := `{"choices":[{"message":{"content":"No encontré registros."}}]}`
	if len(f.steps) > 0 {
		step, f.steps = f.steps[0], f.steps[1:]
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, step)
}

func (f *scriptedModel) requests() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.bodies...)
}

func toolCall(id, name, args string) string {
	a, _ := json.Marshal(args)
	return `{"choices":[{"message":{"content":null,"tool_calls":[{"id":"` + id + `","type":"function","function":{"name":"` + name + `","arguments":` + string(a) + `}}]}}]}`
}

// analystSetup switches external AI for ACME/NORTE and points the analyst at a scripted model.
func analystSetup(t *testing.T, externalAI bool) *scriptedModel {
	t.Helper()
	if scratch == nil {
		t.Skip("set SIPGES_TEST_DATABASE_URL to run the analyst integration tests")
	}
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	settings := `{"externalAi":{"enabled":false}}`
	if externalAI {
		settings = `{"externalAi":{"enabled":true}}`
	}
	if _, err := conn.Exec(t.Context(), `
		INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at)
		VALUES ('ACME/NORTE', $1, 'test', now())
		ON CONFLICT (tenant_id) DO UPDATE SET settings = EXCLUDED.settings`, settings); err != nil {
		t.Fatal(err)
	}
	model := &scriptedModel{}
	srv := httptest.NewServer(model)
	t.Cleanup(srv.Close)
	t.Setenv("SIPGES_ANALYST_PROVIDER", "openai-compatible")
	t.Setenv("SIPGES_ANALYST_BASE_URL", srv.URL)
	t.Setenv("SIPGES_ANALYST_MODEL", "scripted-model")
	return model
}

func askAs(t *testing.T, s *server, user, scope, question string) reply {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"question": question})
	return s.do(t, req{method: http.MethodPost, path: "/system/analyst/ask", user: user, sameOrigin: true,
		headers: map[string]string{"X-SIPGES-Scope": scope, "Content-Type": "application/json"},
		body:    string(body)})
}

func TestAnalystReadsAsTheSessionInItsProject(t *testing.T) {
	for _, tc := range []struct{ user, secret string }{
		{"reader", `Registro no encontrado`}, // limited clearance: RLS hides the restricted record
		{"multi", `\"withheld\":true`},       // full clearance: the guard withholds its content
	} {
		t.Run(tc.user, func(t *testing.T) {
			model := analystSetup(t, true)
			t.Setenv("SIPGES_DATA_KEY", dataKey)
			model.steps = []string{
				toolCall("c1", "get_record", `{"module":"eventos","id":"north-secret"}`),
				toolCall("c2", "get_record", `{"module":"eventos","id":"south"}`),
				toolCall("c3", "create_record", `{"module":"eventos","payload":{}}`),
				toolCall("c4", "get_record", `{"module":"eventos","id":"north"}`),
				`{"choices":[{"message":{"content":"Hay un evento [1]."}}]}`,
			}
			got := askAs(t, start(t, false), tc.user, "ACME/NORTE", "¿Qué pasó en el norte?")
			if got.status != http.StatusOK || !strings.Contains(got.body, `"id":"north"`) {
				t.Fatalf("status %d, body %s", got.status, got.body)
			}
			bodies := model.requests()
			if len(bodies) != 5 {
				t.Fatalf("the model saw %d requests, want 5", len(bodies))
			}
			last := bodies[4]
			if !strings.Contains(last, tc.secret) {
				t.Errorf("restricted record: %q missing from %s", tc.secret, last)
			}
			if !strings.Contains(last, "Herramienta desconocida: create_record") {
				t.Errorf("the write tool was not refused: %s", last)
			}
			// south belongs to SIPGES/PRJ-SECHURA: from ACME/NORTE it does not exist.
			at := strings.Index(last, `"tool_call_id":"c2"`)
			if at < 0 || !strings.Contains(last[max(0, at-120):at], "Registro no encontrado") {
				t.Errorf("another project's record answered: %s", last)
			}
		})
	}
}

func TestAnalystScrubsAndLogsTheQuestionBeforeTheModel(t *testing.T) {
	model := analystSetup(t, true)
	t.Setenv("SIPGES_DATA_KEY", dataKey)
	got := askAs(t, start(t, false), "reader", "ACME/NORTE", "que paso con ana@example.org")
	if got.status != http.StatusOK {
		t.Fatalf("status %d, body %s", got.status, got.body)
	}
	bodies := model.requests()
	if len(bodies) != 1 || strings.Contains(bodies[0], "ana@example.org") || !strings.Contains(bodies[0], "[correo]") {
		t.Fatalf("the question reached the model unscrubbed: %v", bodies)
	}
	conn, err := pgx.Connect(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	var released int
	if err := conn.QueryRow(t.Context(), `SELECT count(*) FROM audit WHERE tenant_id = 'ACME/NORTE'
		AND action = 'EGRESS' AND detail LIKE '%analyst%' AND detail LIKE '%ask%'`).Scan(&released); err != nil {
		t.Fatal(err)
	}
	if released == 0 {
		t.Fatal("the question's release was not logged")
	}
}

func TestAnalystNeverCallsTheModelWhileExternalAIIsOffOrWithoutDataKey(t *testing.T) {
	t.Run("switch off", func(t *testing.T) {
		model := analystSetup(t, false)
		t.Setenv("SIPGES_DATA_KEY", dataKey)
		got := askAs(t, start(t, false), "reader", "ACME/NORTE", "hola")
		if got.status != http.StatusConflict || !strings.Contains(got.body, "desactivado") || len(model.requests()) != 0 {
			t.Fatalf("status %d, body %s, model requests %d", got.status, got.body, len(model.requests()))
		}
	})
	t.Run("no data key", func(t *testing.T) {
		model := analystSetup(t, true)
		t.Setenv("SIPGES_DATA_KEY", "")
		_ = os.Unsetenv("SIPGES_DATA_KEY")
		got := askAs(t, start(t, false), "reader", "ACME/NORTE", "hola")
		if got.status != http.StatusConflict || len(model.requests()) != 0 {
			t.Fatalf("status %d, model requests %d", got.status, len(model.requests()))
		}
	})
}

func TestAnalystIsOpenToReadOnlyRolesInTheirProjectsOnly(t *testing.T) {
	_ = analystSetup(t, true)
	t.Setenv("SIPGES_DATA_KEY", dataKey)
	s := start(t, false)
	for _, user := range []string{"reader", "coord"} {
		if got := askAs(t, s, user, "ACME/NORTE", "hola"); got.status != http.StatusOK {
			t.Fatalf("%s: status %d, body %s", user, got.status, got.body)
		}
	}
	if got := askAs(t, s, "reader", "SIPGES/PRJ-SECHURA", "hola"); got.status != http.StatusForbidden {
		t.Fatalf("an ungranted project answered %d", got.status)
	}
}

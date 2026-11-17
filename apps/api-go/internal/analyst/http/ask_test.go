//nolint:misspell // Spanish record modules and messages in synthetic fixtures.
package http_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	analysthttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/infrastructure"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	tenancydomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

type stepModel struct{ steps []application.Step }

func (m *stepModel) Next(context.Context, []application.ToolSpec, []application.Turn) (application.Step, error) {
	step := m.steps[0]
	m.steps = m.steps[1:]
	return step, nil
}

type oneTool struct{ refs []domain.RecordRef }

func (o oneTool) Specs() []application.ToolSpec {
	return []application.ToolSpec{{Name: "search_records"}}
}
func (o oneTool) Run(context.Context, string, json.RawMessage) (application.ToolOutput, error) {
	return application.ToolOutput{OK: true, Records: o.refs}, nil
}

func ask(t *testing.T, opts analysthttp.Options, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	analysthttp.Routes(mux, opts)
	req := httptest.NewRequestWithContext(
		tenancyhttp.WithScope(t.Context(), tenancydomain.Scope{CompanyID: "ACME", ProjectID: "NORTE"}),
		http.MethodPost, "/system/analyst/ask", strings.NewReader(body))
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	return res
}

func analystFor(model application.ToolModel, tools application.ToolRunner, seen *string) func(context.Context, string) (*application.Ask, error) {
	return func(_ context.Context, tenantID string) (*application.Ask, error) {
		if seen != nil {
			*seen = tenantID
		}
		return &application.Ask{Model: model, Tools: tools, Seal: func(_ context.Context, q string) (privacy.Sanitised[string], error) {
			return privacy.ExemptPayload(q, privacy.ExemptConstant), nil
		}}, nil
	}
}

func TestAskAnswersWithItsCitedSources(t *testing.T) {
	t.Parallel()
	var tenant string
	refs := []domain.RecordRef{{Slug: "conflictos", ID: "C-1", Title: "Bloqueo de vía"}}
	model := &stepModel{steps: []application.Step{
		{Calls: []application.ToolCall{{ID: "1", Name: "search_records"}}},
		{Text: "El bloqueo sigue [1]."},
	}}
	res := ask(t, analysthttp.Options{Ask: analystFor(model, oneTool{refs}, &tenant)}, `{"question":" ¿Qué pasa en el norte? "}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body)
	}
	// answer and sources keep their T1 shape; blocks is always a list, empty without blocks.
	if strings.TrimSpace(res.Body.String()) != `{"answer":"El bloqueo sigue [1].","sources":[{"n":1,"module":"conflictos","id":"C-1","title":"Bloqueo de vía"}],"blocks":[]}` {
		t.Fatalf("body = %s", res.Body)
	}
	if tenant != "ACME/NORTE" {
		t.Fatalf("tenant = %q, want the selected project", tenant)
	}
}

func TestAskRefusesAnEmptyOrLongQuestion(t *testing.T) {
	t.Parallel()
	opts := analysthttp.Options{Ask: analystFor(&stepModel{}, oneTool{}, nil)}
	for _, body := range []string{`{"question":"   "}`, `{}`, `nope`, `{"question":"` + strings.Repeat("a", 501) + `"}`} {
		if res := ask(t, opts, body); res.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%.20s: status = %d", body, res.Code)
		}
	}
}

func TestAskSaysWhenExternalAIIsOffOrNotConfigured(t *testing.T) {
	t.Parallel()
	off := analysthttp.Options{Ask: func(context.Context, string) (*application.Ask, error) { return nil, privacy.ErrDisabled }}
	res := ask(t, off, `{"question":"¿Algo?"}`)
	if res.Code != http.StatusConflict || !strings.Contains(res.Body.String(), privacy.ExternalAIDisabled) {
		t.Fatalf("off: status = %d, body = %s", res.Code, res.Body)
	}
	if res := ask(t, analysthttp.Options{}, `{"question":"¿Algo?"}`); res.Code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured: status = %d", res.Code)
	}
}

func TestAskRefusesAnAnswerWithBadCitations(t *testing.T) {
	t.Parallel()
	model := &stepModel{steps: []application.Step{{Text: "Hubo heridos [3]."}}}
	res := ask(t, analysthttp.Options{Ask: analystFor(model, oneTool{}, nil)}, `{"question":"¿Heridos?"}`)
	if res.Code != http.StatusBadGateway || strings.Contains(res.Body.String(), "heridos") {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body)
	}
}

func TestAskReportsAFailedFactoryWithoutDetails(t *testing.T) {
	t.Parallel()
	broken := analysthttp.Options{Ask: func(context.Context, string) (*application.Ask, error) {
		return nil, errors.New("dial tcp secret-host")
	}}
	res := ask(t, broken, `{"question":"¿Algo?"}`)
	if res.Code != http.StatusInternalServerError || strings.Contains(res.Body.String(), "secret-host") {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body)
	}
}

// providerDown is the answer of a question whose model provider cannot be reached (local QA T6):
// the bridge stopped, its login expired, its quota ran out, or the provider failed.
const providerDown = `{"detail":"El analista no respondió: el servicio de IA no está disponible. ` +
	`Prueba de nuevo en unos minutos o avisa a quien administra SIPGES."}`

func TestAskSaysTheAnalystDidNotAnswerWhenItsProviderIsDown(t *testing.T) {
	t.Parallel()
	answering := func(status int) string {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":{"message":"synthetic provider detail"}}`))
		}))
		t.Cleanup(srv.Close)
		return srv.URL
	}
	closed := httptest.NewServer(http.NotFoundHandler())
	refused := closed.URL
	closed.Close()
	bases := map[string]string{
		"connection refused": refused,
		"unknown host":       "http://sipges-claude-bridge.invalid",
		"login expired":      answering(http.StatusUnauthorized),
		"forbidden":          answering(http.StatusForbidden),
		"quota exhausted":    answering(http.StatusTooManyRequests),
		"provider error":     answering(http.StatusInternalServerError),
		"bridge down":        answering(http.StatusBadGateway),
	}
	for name, base := range bases {
		models := map[string]application.ToolModel{
			"claude": infrastructure.NewClaude("m", lookup(map[string]string{
				"ANTHROPIC_BASE_URL": base, "ANTHROPIC_API_KEY": "synthetic-test-value",
			})),
			"openai-compatible": infrastructure.NewOpenAICompatible("m", lookup(map[string]string{
				"SIPGES_ANALYST_BASE_URL": base, "SIPGES_ANALYST_API_KEY": "synthetic-test-value",
			})),
		}
		for provider, model := range models {
			t.Run(provider+"/"+name, func(t *testing.T) {
				t.Parallel()
				res := ask(t, analysthttp.Options{Ask: analystFor(model, oneTool{}, nil)}, `{"question":"¿Algo?"}`)
				if res.Code != http.StatusServiceUnavailable || strings.TrimSpace(res.Body.String()) != providerDown {
					t.Fatalf("status = %d, body = %s", res.Code, res.Body)
				}
			})
		}
	}
}

func TestAskKeepsANoAnswerForAModelThatAnsweredBadly(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	}))
	t.Cleanup(srv.Close)
	model := infrastructure.NewClaude("m", lookup(map[string]string{
		"ANTHROPIC_BASE_URL": srv.URL, "ANTHROPIC_API_KEY": "synthetic-test-value",
	}))
	res := ask(t, analysthttp.Options{Ask: analystFor(model, oneTool{}, nil)}, `{"question":"¿Algo?"}`)
	want := `{"detail":"El analista no llegó a una respuesta; vuelve a preguntar"}`
	if res.Code != http.StatusBadGateway || strings.TrimSpace(res.Body.String()) != want {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body)
	}
}

func lookup(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

func TestAskTreatsADisconnectedClientAsNoServerFault(t *testing.T) {
	t.Parallel()
	gone := analysthttp.Options{Ask: func(context.Context, string) (*application.Ask, error) { return nil, context.Canceled }}
	if res := ask(t, gone, `{"question":"¿Algo?"}`); res.Code != analysthttp.StatusClientClosed {
		t.Fatalf("status = %d, want %d", res.Code, analysthttp.StatusClientClosed)
	}
}

func TestAskSendsTheTypedBlocksNextToTheAnswer(t *testing.T) {
	t.Parallel()
	refs := []domain.RecordRef{{Slug: "conflictos", ID: "C-1", Title: "Bloqueo de vía"}}
	model := &stepModel{steps: []application.Step{
		{Calls: []application.ToolCall{{ID: "1", Name: "search_records"}}},
		{Text: "El bloqueo sigue [1].\n```bloques\n[" +
			`{"tipo":"registro","fuente":1},{"tipo":"alerta","fuente":1,"texto":"<b>Paro</b> anunciado"},` +
			`{"tipo":"mapa","fuente":1},{"tipo":"cronologia","fuente":1,"eventos":[{"fecha":"2026-03-02","texto":"Inicio"}]},` +
			`{"tipo":"desconocido","fuente":1}]` + "\n```"},
	}}
	res := ask(t, analysthttp.Options{Ask: analystFor(model, oneTool{refs}, nil)}, `{"question":"¿Qué pasa?"}`)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body)
	}
	source := `"n":1,"module":"conflictos","id":"C-1","title":"Bloqueo de vía"`
	// The alert text is data: JSON escapes it, and the screen shows it as text.
	want := `{"answer":"El bloqueo sigue [1].","sources":[{` + source + `}],"blocks":[` +
		`{"type":"record",` + source + `},` +
		`{"type":"alert",` + source + `,"text":"\u003cb\u003eParo\u003c/b\u003e anunciado"},` +
		`{"type":"map",` + source + `},` +
		`{"type":"timeline",` + source + `,"entries":[{"date":"2026-03-02","text":"Inicio"}]}]}`
	if got := strings.TrimSpace(res.Body.String()); got != want {
		t.Fatalf("body = %s\nwant   %s", got, want)
	}
}

func TestAnalystStatusSaysWhetherTheInstallationHasAnAnalyst(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		opts analysthttp.Options
		want string
	}{
		{analysthttp.Options{}, `{"available":false}`},
		{analysthttp.Options{Ask: analystFor(&stepModel{}, oneTool{}, nil)}, `{"available":true}`},
	} {
		mux := http.NewServeMux()
		analysthttp.Routes(mux, tc.opts)
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/system/analyst", nil))
		if res.Code != http.StatusOK || strings.TrimSpace(res.Body.String()) != tc.want {
			t.Fatalf("status %d, body %s, want %s", res.Code, res.Body, tc.want)
		}
	}
}

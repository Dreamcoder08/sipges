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
		return &application.Ask{Model: model, Tools: tools}, nil
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
	if res.Body.String() != `{"answer":"El bloqueo sigue [1].","sources":[{"n":1,"module":"conflictos","id":"C-1","title":"Bloqueo de vía"}]}`+"\n" &&
		res.Body.String() != `{"answer":"El bloqueo sigue [1].","sources":[{"n":1,"module":"conflictos","id":"C-1","title":"Bloqueo de vía"}]}` {
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

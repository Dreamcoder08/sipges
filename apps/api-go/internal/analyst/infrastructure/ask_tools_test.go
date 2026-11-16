//nolint:misspell // Spanish record modules and messages in synthetic fixtures.
package infrastructure

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
)

var askTools = []application.ToolSpec{{
	Name: "search_records", Description: "Busca registros", InputSchema: json.RawMessage(`{"type":"object"}`),
}}

// askTurns is a question, one call and its answer with one numbered record.
func askTurns() []application.Turn {
	call := application.ToolCall{ID: "toolu_1", Name: "search_records", Input: json.RawMessage(`{"query":"bloqueo"}`)}
	ref := domain.RecordRef{Slug: "conflictos", ID: "C-1", Title: "Bloqueo de vía"}
	return []application.Turn{
		{Question: privacy.ExemptPayload("¿Qué pasa en el norte?", privacy.ExemptConstant)},
		{Calls: []application.ToolCall{call}},
		{Result: &application.ToolTurn{
			Call:    call,
			Output:  application.ToolOutput{OK: true, Data: privacy.ExemptPayload[any](map[string]any{"total": 1}, privacy.ExemptConstant), Records: []domain.RecordRef{ref}},
			Sources: []domain.Cited{{N: 1, RecordRef: ref}},
		}},
	}
}

func capture(t *testing.T, answer string) (*httptest.Server, *map[string]any, *http.Header) {
	t.Helper()
	sent := map[string]any{}
	var header http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header = r.Header.Clone()
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &sent)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(answer))
	}))
	t.Cleanup(srv.Close)
	return srv, &sent, &header
}

func TestClaudeNextSendsToolsAndToolResults(t *testing.T) {
	t.Parallel()
	srv, sent, header := capture(t, `{"stop_reason":"end_turn","content":[{"type":"text","text":" El bloqueo sigue [1]. "}]}`)
	c := NewClaude("claude-opus-5-5", environment(map[string]string{"ANTHROPIC_BASE_URL": srv.URL, "ANTHROPIC_API_KEY": "synthetic-test-value"}))
	step, err := c.Next(t.Context(), askTools, askTurns())
	if err != nil {
		t.Fatal(err)
	}
	if step.Text != "El bloqueo sigue [1]." || len(step.Calls) != 0 {
		t.Fatalf("step = %+v", step)
	}
	if header.Get("Authorization") != "Bearer synthetic-test-value" || header.Get("anthropic-version") == "" {
		t.Fatalf("headers = %v", header)
	}
	body := *sent
	tools, _ := body["tools"].([]any)
	if len(tools) != 1 || tools[0].(map[string]any)["name"] != "search_records" || tools[0].(map[string]any)["input_schema"] == nil {
		t.Fatalf("tools = %v", body["tools"])
	}
	if !strings.Contains(body["system"].(string), "[n]") {
		t.Fatalf("system = %v", body["system"])
	}
	messages, _ := body["messages"].([]any)
	if len(messages) != 3 {
		t.Fatalf("messages = %v", messages)
	}
	use := messages[1].(map[string]any)["content"].([]any)[0].(map[string]any)
	if messages[1].(map[string]any)["role"] != "assistant" || use["type"] != "tool_use" || use["id"] != "toolu_1" {
		t.Fatalf("assistant turn = %v", messages[1])
	}
	result := messages[2].(map[string]any)["content"].([]any)[0].(map[string]any)
	if messages[2].(map[string]any)["role"] != "user" || result["type"] != "tool_result" || result["tool_use_id"] != "toolu_1" {
		t.Fatalf("tool result turn = %v", messages[2])
	}
	content, _ := result["content"].(string)
	if !strings.Contains(content, `"n":1`) || !strings.Contains(content, `"id":"C-1"`) || !strings.Contains(content, `"total":1`) {
		t.Fatalf("tool result content = %s", content)
	}
}

func TestClaudeNextReadsToolCalls(t *testing.T) {
	t.Parallel()
	srv, _, _ := capture(t, `{"stop_reason":"tool_use","content":[{"type":"text","text":"Busco."},{"type":"tool_use","id":"toolu_9","name":"get_record","input":{"module":"conflictos","id":"C-1"}}]}`)
	c := NewClaude("claude-opus-5-5", environment(map[string]string{"ANTHROPIC_BASE_URL": srv.URL, "ANTHROPIC_API_KEY": "synthetic-test-value"}))
	step, err := c.Next(t.Context(), askTools, askTurns()[:1])
	if err != nil {
		t.Fatal(err)
	}
	if len(step.Calls) != 1 || step.Calls[0].ID != "toolu_9" || step.Calls[0].Name != "get_record" || !strings.Contains(string(step.Calls[0].Input), `"C-1"`) {
		t.Fatalf("step = %+v", step)
	}
}

func TestClaudeNextRefusesADeclinedOrCutAnswer(t *testing.T) {
	t.Parallel()
	for _, reason := range []string{"refusal", "max_tokens"} {
		srv, _, _ := capture(t, `{"stop_reason":"`+reason+`","content":[]}`)
		c := NewClaude("m", environment(map[string]string{"ANTHROPIC_BASE_URL": srv.URL, "ANTHROPIC_API_KEY": "synthetic-test-value"}))
		if _, err := c.Next(t.Context(), askTools, askTurns()[:1]); err == nil {
			t.Fatalf("%s: expected an error", reason)
		}
	}
}

func TestOpenAICompatibleNextSendsFunctionToolsAndToolMessages(t *testing.T) {
	t.Parallel()
	srv, sent, _ := capture(t, `{"choices":[{"finish_reason":"stop","message":{"content":"El bloqueo sigue [1]."}}]}`)
	c := NewOpenAICompatible("local-model", environment(map[string]string{"SIPGES_ANALYST_BASE_URL": srv.URL}))
	step, err := c.Next(t.Context(), askTools, askTurns())
	if err != nil {
		t.Fatal(err)
	}
	if step.Text != "El bloqueo sigue [1]." {
		t.Fatalf("step = %+v", step)
	}
	body := *sent
	tool := body["tools"].([]any)[0].(map[string]any)
	if _, hasID := tool["id"]; hasID || tool["type"] != "function" || tool["function"].(map[string]any)["name"] != "search_records" {
		t.Fatalf("tools = %v", body["tools"])
	}
	messages := body["messages"].([]any)
	if len(messages) != 4 || messages[0].(map[string]any)["role"] != "system" {
		t.Fatalf("messages = %v", messages)
	}
	assistant := messages[2].(map[string]any)
	calls := assistant["tool_calls"].([]any)
	fn := calls[0].(map[string]any)["function"].(map[string]any)
	if assistant["role"] != "assistant" || fn["name"] != "search_records" || fn["arguments"] != `{"query":"bloqueo"}` {
		t.Fatalf("assistant = %v", assistant)
	}
	toolMsg := messages[3].(map[string]any)
	if toolMsg["role"] != "tool" || toolMsg["tool_call_id"] != "toolu_1" || !strings.Contains(toolMsg["content"].(string), `"n":1`) {
		t.Fatalf("tool message = %v", toolMsg)
	}
}

func TestOpenAICompatibleNextReadsToolCalls(t *testing.T) {
	t.Parallel()
	srv, _, _ := capture(t, `{"choices":[{"finish_reason":"tool_calls","message":{"content":null,"tool_calls":[{"id":"call_2","type":"function","function":{"name":"get_timeline","arguments":"{\"from\":\"2026-01-01\"}"}}]}}]}`)
	c := NewOpenAICompatible("local-model", environment(map[string]string{"SIPGES_ANALYST_BASE_URL": srv.URL}))
	step, err := c.Next(t.Context(), askTools, askTurns()[:1])
	if err != nil {
		t.Fatal(err)
	}
	if len(step.Calls) != 1 || step.Calls[0].ID != "call_2" || string(step.Calls[0].Input) != `{"from":"2026-01-01"}` {
		t.Fatalf("step = %+v", step)
	}
}

func TestToolResultContentCarriesARefusalOnly(t *testing.T) {
	t.Parallel()
	got := toolResultContent(&application.ToolTurn{Output: application.ToolOutput{Refusal: "Herramienta desconocida: x"}})
	if got != `{"error":"Herramienta desconocida: x"}` {
		t.Fatalf("content = %s", got)
	}
}

// The prompt shows the model the blocks format by example; the example must be exactly what the
// domain parses, every kind included, or the model would learn blocks that are always dropped.
func TestAskPromptTeachesTheBlocksTheDomainReads(t *testing.T) {
	t.Parallel()
	if !strings.Contains(askPrompt, askBlocksExample) {
		t.Fatal("the prompt does not show the blocks example")
	}
	text, raw := domain.SplitBlocks("Texto [1].\n" + askBlocksExample)
	var s domain.Sources
	s.Add(domain.RecordRef{Slug: "conflictos", ID: "C-1"})
	s.Add(domain.RecordRef{Slug: "actores", ID: "A-7"})
	blocks := domain.ResolveBlocks(raw, &s)
	kinds := map[domain.BlockKind]bool{}
	for _, b := range blocks {
		kinds[b.Kind] = true
	}
	if text != "Texto [1]." || len(kinds) != 4 {
		t.Fatalf("text = %q, blocks = %+v; want the four kinds", text, blocks)
	}
}

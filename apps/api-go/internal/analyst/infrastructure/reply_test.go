package infrastructure

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
)

func claudeFor(t *testing.T, url string) *Claude {
	t.Helper()
	return NewClaude("claude-opus-5-5", environment(map[string]string{"ANTHROPIC_BASE_URL": url, "ANTHROPIC_API_KEY": "synthetic-test-value"}))
}

// A paused or overflowed turn is not an answer, even when it carries some text.
func TestClaudeNextRefusesAPausedOrOverflowedTurn(t *testing.T) {
	t.Parallel()
	for _, reason := range []string{"pause_turn", "model_context_window_exceeded"} {
		srv, _, _ := capture(t, `{"stop_reason":"`+reason+`","content":[{"type":"text","text":"El bloqueo sigue [1]."}]}`)
		step, err := claudeFor(t, srv.URL).Next(t.Context(), askTools, askTurns()[:1])
		if err == nil {
			t.Fatalf("%s: step = %+v, want an error", reason, step)
		}
	}
}

// Text written next to tool calls is not the answer: the loop goes on with the calls.
func TestClaudeNextIgnoresTextNextToToolCalls(t *testing.T) {
	t.Parallel()
	srv, _, _ := capture(t, `{"stop_reason":"tool_use","content":[{"type":"text","text":"Hubo heridos [1]."},{"type":"tool_use","id":"toolu_1","name":"search_records","input":{"query":"x"}}]}`)
	step, err := claudeFor(t, srv.URL).Next(t.Context(), askTools, askTurns()[:1])
	if err != nil || step.Text != "" || len(step.Calls) != 1 {
		t.Fatalf("step = %+v, err = %v", step, err)
	}
}

// Adaptive thinking answers with thinking blocks (and may add block types this code does not
// know): they are skipped when reading the answer and sent back unchanged with the rest of the
// assistant turn, text and tool calls included, as the API requires when the loop continues.
func TestClaudeNextSendsTheAssistantTurnBackUnchanged(t *testing.T) {
	t.Parallel()
	content := `[{"type":"thinking","thinking":"Busco el bloqueo.","signature":"c2lnbg=="},` +
		`{"type":"redacted_thinking","data":"b3BhcXVl"},{"type":"future_block","value":{"a":1}},` +
		`{"type":"text","text":"Busco."},{"type":"tool_use","id":"toolu_1","name":"search_records","input":{"query":"bloqueo"}}]`
	srv, sent, _ := capture(t, `{"stop_reason":"tool_use","content":`+content+`}`)
	c := claudeFor(t, srv.URL)
	turns := askTurns()[:1]
	step, err := c.Next(t.Context(), askTools, turns)
	if err != nil || len(step.Calls) != 1 || step.Calls[0].Malformed {
		t.Fatalf("step = %+v, err = %v", step, err)
	}
	result := &application.ToolTurn{Call: step.Calls[0], Output: application.ToolOutput{OK: true}}
	turns = append(turns, application.Turn{Calls: step.Calls, Reply: step.Reply}, application.Turn{Result: result})
	if _, err := c.Next(t.Context(), askTools, turns); err != nil {
		t.Fatal(err)
	}
	messages := (*sent)["messages"].([]any)
	var want []any
	_ = json.Unmarshal([]byte(content), &want)
	assistant := messages[1].(map[string]any)
	if assistant["role"] != "assistant" || !reflect.DeepEqual(assistant["content"], want) {
		t.Fatalf("assistant turn = %v\nwant %v", assistant["content"], want)
	}
}

// Tool arguments are parsed with encoding/json: a call whose input is not a JSON object is marked
// malformed, so the loop refuses it instead of running the tool on a guess.
func TestToolCallsWithMalformedArgumentsAreMarked(t *testing.T) {
	t.Parallel()
	for _, in := range []string{`"query=bloqueo"`, `[1,2]`, `null`} {
		srv, _, _ := capture(t, `{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"toolu_1","name":"search_records","input":`+in+`}]}`)
		step, err := claudeFor(t, srv.URL).Next(t.Context(), askTools, askTurns()[:1])
		if err != nil || len(step.Calls) != 1 || !step.Calls[0].Malformed {
			t.Fatalf("claude %s: step = %+v, err = %v", in, step, err)
		}
	}
	for _, args := range []string{`{\"query\": `, `bloqueo`, `[]`} {
		srv, _, _ := capture(t, `{"choices":[{"finish_reason":"tool_calls","message":{"content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"search_records","arguments":"`+args+`"}}]}}]}`)
		c := NewOpenAICompatible("local-model", environment(map[string]string{"SIPGES_ANALYST_BASE_URL": srv.URL}))
		step, err := c.Next(t.Context(), askTools, askTurns()[:1])
		if err != nil || len(step.Calls) != 1 || !step.Calls[0].Malformed || string(step.Calls[0].Input) != `{}` {
			t.Fatalf("openai %s: step = %+v, err = %v", args, step, err)
		}
	}
	// No arguments at all is an empty object, as before, on both providers.
	for _, use := range []string{`"input":{"query":"bloqueo"}`, `"input":{}`, `"x":1`} {
		srv, _, _ := capture(t, `{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"toolu_1","name":"search_records",`+use+`}]}`)
		if step, _ := claudeFor(t, srv.URL).Next(t.Context(), askTools, askTurns()[:1]); len(step.Calls) != 1 || step.Calls[0].Malformed {
			t.Fatalf("claude %s: a well-formed call is marked: %+v", use, step)
		}
	}
	for _, args := range []string{``, ` `, `{}`, `{\"query\":\"bloqueo\"}`} {
		srv, _, _ := capture(t, `{"choices":[{"finish_reason":"tool_calls","message":{"content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"search_records","arguments":"`+args+`"}}]}}]}`)
		c := NewOpenAICompatible("local-model", environment(map[string]string{"SIPGES_ANALYST_BASE_URL": srv.URL}))
		if step, _ := c.Next(t.Context(), askTools, askTurns()[:1]); len(step.Calls) != 1 || step.Calls[0].Malformed {
			t.Fatalf("openai %q: a well-formed call is marked: %+v", args, step)
		}
	}
}

// An answer of whitespace, or of thinking alone, is an empty text the loop refuses.
func TestClaudeNextReadsABlankAnswerAsEmpty(t *testing.T) {
	t.Parallel()
	for _, content := range []string{`[{"type":"text","text":"  \n\t "}]`, `[{"type":"thinking","thinking":"…","signature":"s"}]`, `[]`} {
		srv, _, _ := capture(t, `{"stop_reason":"end_turn","content":`+content+`}`)
		step, err := claudeFor(t, srv.URL).Next(t.Context(), askTools, askTurns()[:1])
		if err != nil || step.Text != "" || len(step.Calls) != 0 {
			t.Fatalf("%s: step = %+v, err = %v", content, step, err)
		}
	}
}

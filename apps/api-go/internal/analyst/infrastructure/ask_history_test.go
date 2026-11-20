package infrastructure

import (
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
)

// followUpTurns is one earlier exchange and then the question (odd/tasks/chat-first-ui.md T9).
func followUpTurns() []application.Turn {
	text := func(s string) privacy.Sanitised[string] { return privacy.ExemptPayload(s, privacy.ExemptConstant) }
	return []application.Turn{
		{Earlier: &application.EarlierTurn{Question: text("¿Qué pasa en el norte?"), Answer: text("La comunidad mantiene el bloqueo.")}},
		{Question: text("¿Desde cuándo?")},
	}
}

// roles lists each message's role and its text, "role:text".
func roles(t *testing.T, messages []any, text func(map[string]any) string) []string {
	t.Helper()
	out := make([]string, 0, len(messages))
	for _, m := range messages {
		message := m.(map[string]any)
		out = append(out, message["role"].(string)+":"+text(message))
	}
	return out
}

func TestClaudeNextSendsEarlierTurnsAsAlternatingTextBeforeTheQuestion(t *testing.T) {
	t.Parallel()
	srv, sent, _ := capture(t, `{"stop_reason":"end_turn","content":[{"type":"text","text":"Sin registros."}]}`)
	c := NewClaude("claude-opus-5-5", environment(map[string]string{"ANTHROPIC_BASE_URL": srv.URL, "ANTHROPIC_API_KEY": "synthetic-test-value"}))
	if _, err := c.Next(t.Context(), askTools, followUpTurns()); err != nil {
		t.Fatal(err)
	}
	messages, _ := (*sent)["messages"].([]any)
	got := roles(t, messages, func(m map[string]any) string {
		return m["content"].([]any)[0].(map[string]any)["text"].(string)
	})
	want := []string{"user:¿Qué pasa en el norte?", "assistant:La comunidad mantiene el bloqueo.", "user:¿Desde cuándo?"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("messages = %q, want %q", got, want)
	}
}

func TestOpenAICompatibleNextSendsEarlierTurnsAsAlternatingTextBeforeTheQuestion(t *testing.T) {
	t.Parallel()
	srv, sent, _ := capture(t, `{"choices":[{"finish_reason":"stop","message":{"content":"Sin registros."}}]}`)
	c := NewOpenAICompatible("local-model", environment(map[string]string{"SIPGES_ANALYST_BASE_URL": srv.URL}))
	if _, err := c.Next(t.Context(), askTools, followUpTurns()); err != nil {
		t.Fatal(err)
	}
	messages, _ := (*sent)["messages"].([]any)
	got := roles(t, messages[1:], func(m map[string]any) string { return m["content"].(string) })
	want := []string{"user:¿Qué pasa en el norte?", "assistant:La comunidad mantiene el bloqueo.", "user:¿Desde cuándo?"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("messages = %q, want %q", got, want)
	}
}

// The prompt tells the model the history is context: a record from it is fetched again to be cited.
func TestAskPromptSaysEarlierTurnsAreContextOnly(t *testing.T) {
	t.Parallel()
	if !strings.Contains(askPrompt, "turnos anteriores") || !strings.Contains(askPrompt, "vuelve a buscarlo") {
		t.Fatalf("askPrompt does not explain earlier turns: %s", askPrompt)
	}
}

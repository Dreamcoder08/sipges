package infrastructure

import (
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
)

func TestClaudeNextReadsTheUsageAndTheModel(t *testing.T) {
	t.Parallel()
	srv, _, _ := capture(t, `{"model":"claude-opus-5-5","stop_reason":"end_turn","content":[{"type":"text","text":"Nada."}],`+
		`"usage":{"input_tokens":12,"output_tokens":34,"cache_creation_input_tokens":2048,"cache_read_input_tokens":4096}}`)
	c := NewClaude("claude-opus-5-5", environment(map[string]string{"ANTHROPIC_BASE_URL": srv.URL, "ANTHROPIC_API_KEY": "synthetic-test-value"}))
	step, err := c.Next(t.Context(), askTools, askTurns()[:1])
	if err != nil {
		t.Fatal(err)
	}
	want := application.Usage{Input: 12, Output: 34, CacheCreation: 2048, CacheRead: 4096}
	if step.Usage != want || step.Model != "claude-opus-5-5" {
		t.Fatalf("usage = %+v, model = %q", step.Usage, step.Model)
	}
}

// A refused or cut answer is still billed: its usage comes back with the error.
func TestClaudeNextKeepsTheUsageOfAFailedStep(t *testing.T) {
	t.Parallel()
	srv, _, _ := capture(t, `{"stop_reason":"max_tokens","content":[],"usage":{"input_tokens":5,"output_tokens":2000}}`)
	c := NewClaude("claude-opus-5-5", environment(map[string]string{"ANTHROPIC_BASE_URL": srv.URL, "ANTHROPIC_API_KEY": "synthetic-test-value"}))
	step, err := c.Next(t.Context(), askTools, askTurns()[:1])
	if err == nil || step.Usage != (application.Usage{Input: 5, Output: 2000}) {
		t.Fatalf("usage = %+v, err = %v", step.Usage, err)
	}
}

// OpenAI counts cached tokens inside prompt_tokens; the usage keeps Claude's meaning, where input
// is what was not read from the cache.
func TestOpenAICompatibleNextReadsTheUsage(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		usage string
		want  application.Usage
	}{
		{`{"prompt_tokens":1500,"completion_tokens":80,"prompt_tokens_details":{"cached_tokens":1024}}`, application.Usage{Input: 476, Output: 80, CacheRead: 1024}},
		{`{"prompt_tokens":300,"completion_tokens":20}`, application.Usage{Input: 300, Output: 20}},
	} {
		srv, _, _ := capture(t, `{"model":"local-model","choices":[{"finish_reason":"stop","message":{"content":"Nada."}}],"usage":`+tc.usage+`}`)
		c := NewOpenAICompatible("local-model", environment(map[string]string{"SIPGES_ANALYST_BASE_URL": srv.URL}))
		step, err := c.Next(t.Context(), askTools, askTurns()[:1])
		if err != nil {
			t.Fatal(err)
		}
		if step.Usage != tc.want || step.Model != "local-model" {
			t.Fatalf("%s: usage = %+v, model = %q", tc.usage, step.Usage, step.Model)
		}
	}
}

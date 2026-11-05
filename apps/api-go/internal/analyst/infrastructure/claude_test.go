package infrastructure

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/anthropics/anthropic-sdk-go/v2/option"

	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
)

func cleared(text string) privacy.Sanitised[string] {
	return privacy.ExemptPayload(text, privacy.ExemptConstant)
}

func answer(stopReason, content string) string {
	return `{"id":"msg_1","type":"message","role":"assistant","model":"m","stop_reason":"` + stopReason +
		`","stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1},"content":` + content + `}`
}

// double is a synthetic Messages API; no real provider is ever contacted here.
func double(t *testing.T, handler http.HandlerFunc) *Claude {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return NewClaude("claude-opus-5-5", option.WithBaseURL(srv.URL), option.WithAPIKey("synthetic-test-value"))
}

func TestNameIsTheOneTypeScriptAnswers(t *testing.T) {
	t.Parallel()
	if got := NewClaude("claude-opus-5-5").Name(); got != "claude:claude-opus-5-5" {
		t.Fatalf("name = %q", got)
	}
}

func TestNarrateSendsOnlyTheBriefingWithFallbacks(t *testing.T) {
	t.Parallel()
	var (
		path, beta, key, query string
		body                   map[string]any
		raw                    []byte
	)
	claude := double(t, func(w http.ResponseWriter, r *http.Request) {
		path, query, beta, key = r.URL.Path, r.URL.RawQuery, r.Header.Get("anthropic-beta"), r.Header.Get("Authorization")
		raw, _ = io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, answer("end_turn", `[{"type":"thinking","thinking":"","signature":"s"},{"type":"text","text":" Párrafo "},{"type":"text","text":"[1]. "}]`))
	})
	got, err := claude.Narrate(t.Context(), cleared("- Hecho. [1]"))
	if err != nil {
		t.Fatal(err)
	}
	if got != "Párrafo [1]." {
		t.Fatalf("text = %q", got)
	}
	if path != "/v1/messages" || query != "beta=true" || beta != "server-side-fallback-2026-07-01" || key != "Bearer synthetic-test-value" {
		t.Fatalf("%s?%s beta %q key %q", path, query, beta, key)
	}
	if body["model"] != "claude-opus-5-5" || body["max_tokens"] != float64(4000) || body["fallbacks"] != "default" {
		t.Fatalf("body = %s", raw)
	}
	if effort := body["output_config"].(map[string]any)["effort"]; effort != "low" {
		t.Fatalf("effort = %v", effort)
	}
	messages := body["messages"].([]any)
	first := messages[0].(map[string]any)
	if len(messages) != 1 || first["role"] != "user" || first["content"] != "<informe>\n- Hecho. [1]\n</informe>" {
		t.Fatalf("messages = %v", messages)
	}
	system, _ := body["system"].(string)
	if !strings.HasPrefix(system, "Eres analista de conflictividad social") || !strings.HasSuffix(system, "sin títulos ni listas.") {
		t.Fatalf("system = %q", system)
	}
	if _, sent := body["betas"]; sent {
		t.Fatal("betas go in the header")
	}
}

func TestNarrateKeepsHalfAnEmojiAsTypeScriptSendsIt(t *testing.T) {
	t.Parallel()
	var raw string
	claude := double(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		raw = string(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, answer("end_turn", `[{"type":"text","text":"x"}]`))
	})
	if _, err := claude.Narrate(t.Context(), cleared("a\xed\xa0\xbdb")); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, `a\ud83db`) {
		t.Fatalf("body = %s", raw)
	}
}

func TestNarrateRefusesRefusalsAndTruncatedAnswers(t *testing.T) {
	t.Parallel()
	for _, stop := range []string{"refusal", "max_tokens"} {
		claude := double(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, answer(stop, `[{"type":"text","text":"x [1]"}]`))
		})
		if got, err := claude.Narrate(t.Context(), cleared("b")); err == nil {
			t.Fatalf("%s: got %q", stop, got)
		}
	}
}

func TestNarrateRetriesOnce(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	claude := double(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "0")
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	if _, err := claude.Narrate(t.Context(), cleared("b")); err == nil {
		t.Fatal("expected the error")
	}
	if calls.Load() != 2 {
		t.Fatalf("calls = %d", calls.Load())
	}
}

func TestNarrateNeverFollowsARedirect(t *testing.T) {
	t.Parallel()
	var reached atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached.Store(true) }))
	t.Cleanup(target.Close)
	claude := double(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	})
	if _, err := claude.Narrate(t.Context(), cleared("b")); err == nil {
		t.Fatal("expected the error")
	}
	if reached.Load() {
		t.Fatal("the text reached the redirect target")
	}
}

package infrastructure

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func completion(finishReason, content string) string {
	return `{"id":"c1","object":"chat.completion","model":"m","usage":{"prompt_tokens":1,"completion_tokens":1},` +
		`"choices":[{"index":0,"finish_reason":"` + finishReason + `","message":{"role":"assistant","content":` + content + `}}]}`
}

// compatibleDouble is a synthetic Chat Completions server; no real provider is ever contacted here.
func compatibleDouble(t *testing.T, handler http.HandlerFunc) *OpenAICompatible {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return NewOpenAICompatible("deepseek-chat", environment(map[string]string{
		"SIPGES_ANALYST_BASE_URL": srv.URL, "SIPGES_ANALYST_API_KEY": "synthetic-test-value",
	}))
}

func TestCompatibleNameCarriesTheModel(t *testing.T) {
	t.Parallel()
	if got := NewOpenAICompatible("llama3.1:8b", environment(nil)).Name(); got != "openai-compatible:llama3.1:8b" {
		t.Fatalf("name = %q", got)
	}
}

func TestCompatibleEndpointJoinsTheBaseURL(t *testing.T) {
	t.Parallel()
	cases := []struct{ base, want string }{
		{"https://api.deepseek.com", "https://api.deepseek.com/v1/chat/completions"},
		{"https://api.deepseek.com/", "https://api.deepseek.com/v1/chat/completions"},
		{"https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions"},
		{"https://api.openai.com/v1/", "https://api.openai.com/v1/chat/completions"},
		{"https://openrouter.ai/api", "https://openrouter.ai/api/v1/chat/completions"},
		{"https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/chat/completions"},
		{"http://127.0.0.1:11434", "http://127.0.0.1:11434/v1/chat/completions"},
		{" http://localhost:11434/v1 \n", "http://localhost:11434/v1/chat/completions"},
		{"https://host.example.test/v10", "https://host.example.test/v10/v1/chat/completions"},
		{"https://host.example.test/prefix", "https://host.example.test/prefix/v1/chat/completions"},
	}
	for _, c := range cases {
		got := NewOpenAICompatible("m", environment(map[string]string{"SIPGES_ANALYST_BASE_URL": c.base})).endpoint
		if got != c.want {
			t.Errorf("%q: endpoint = %q, want %q", c.base, got, c.want)
		}
	}
}

func TestCompatibleSendsOnlyTheBriefing(t *testing.T) {
	t.Parallel()
	var (
		method, path, query, auth, contentType string
		body                                   map[string]any
		raw                                    []byte
	)
	narrator := compatibleDouble(t, func(w http.ResponseWriter, r *http.Request) {
		method, path, query, auth, contentType = r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"), r.Header.Get("Content-Type")
		raw, _ = io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, completion("stop", `"  Párrafo [1].\n"`))
	})
	got, err := narrator.Narrate(t.Context(), cleared("- Hecho. [1]"))
	if err != nil {
		t.Fatal(err)
	}
	if got != "Párrafo [1]." {
		t.Fatalf("text = %q", got)
	}
	if method != http.MethodPost || path != "/v1/chat/completions" || query != "" || auth != "Bearer synthetic-test-value" || contentType != "application/json" {
		t.Fatalf("%s %s?%s auth %q type %q", method, path, query, auth, contentType)
	}
	if len(body) != 3 || body["model"] != "deepseek-chat" || body["max_tokens"] != float64(4000) {
		t.Fatalf("body = %s", raw)
	}
	messages, _ := body["messages"].([]any)
	if len(messages) != 2 {
		t.Fatalf("messages = %s", raw)
	}
	system, _ := messages[0].(map[string]any)
	user, _ := messages[1].(map[string]any)
	if system["role"] != "system" || system["content"] != systemPrompt {
		t.Fatalf("system = %v", system)
	}
	if user["role"] != "user" || user["content"] != "<informe>\n- Hecho. [1]\n</informe>" {
		t.Fatalf("user = %v", user)
	}
}

func TestCompatibleKeepsHalfAnEmojiAsTypeScriptSendsIt(t *testing.T) {
	t.Parallel()
	var raw string
	narrator := compatibleDouble(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		raw = string(body)
		_, _ = io.WriteString(w, completion("stop", `"x"`))
	})
	if _, err := narrator.Narrate(t.Context(), cleared("a\xed\xa0\xbdb")); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, `a\ud83db`) {
		t.Fatalf("body = %s", raw)
	}
}

func TestCompatibleSendsNoAuthorizationWithoutAKey(t *testing.T) {
	t.Parallel()
	var sent atomic.Bool
	var header http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sent.Store(true)
		header = r.Header.Clone()
		_, _ = io.WriteString(w, completion("stop", `"x"`))
	}))
	t.Cleanup(srv.Close)
	narrator := NewOpenAICompatible("llama3.1:8b", environment(map[string]string{"SIPGES_ANALYST_BASE_URL": srv.URL}))
	if _, err := narrator.Narrate(t.Context(), cleared("b")); err != nil {
		t.Fatal(err)
	}
	if !sent.Load() {
		t.Fatal("nothing was sent")
	}
	if _, present := header["Authorization"]; present {
		t.Fatalf("Authorization sent without a key: %v", header)
	}
}

func TestCompatibleTrimsTheKey(t *testing.T) {
	t.Parallel()
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		_, _ = io.WriteString(w, completion("stop", `"x"`))
	}))
	t.Cleanup(srv.Close)
	narrator := NewOpenAICompatible("m", environment(map[string]string{
		"SIPGES_ANALYST_BASE_URL": srv.URL, "SIPGES_ANALYST_API_KEY": " k\n",
	}))
	if _, err := narrator.Narrate(t.Context(), cleared("b")); err != nil || auth != "Bearer k" {
		t.Fatalf("auth %q, %v", auth, err)
	}
}

func TestCompatibleFinishReason(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		answer  string
		want    string
		message string
	}{
		{"stop", completion("stop", `"Texto [1]."`), "Texto [1].", ""},
		{"a provider that sends no finish_reason", `{"choices":[{"message":{"content":"Texto"}}]}`, "Texto", ""},
		{"a null finish_reason", `{"choices":[{"finish_reason":null,"message":{"content":"Texto"}}]}`, "Texto", ""},
		{"length", completion("length", `"Texto cortado"`), "", "narrator: the narrative was truncated"},
		{"content_filter", completion("content_filter", `"Texto"`), "", "narrator: the model declined the briefing"},
		{"empty content", completion("stop", `""`), "", "narrator: the model returned no text"},
		{"blank content", completion("stop", `" \n "`), "", "narrator: the model returned no text"},
		{"null content", completion("stop", `null`), "", "narrator: the model returned no text"},
		{"no message", `{"choices":[{"finish_reason":"stop"}]}`, "", "narrator: the model returned no text"},
		{"no choices", `{"choices":[]}`, "", "narrator: the model returned no text"},
		{"missing choices", `{}`, "", "narrator: the model returned no text"},
		{"a null answer", `null`, "", "narrator: unreadable answer"},
		{"not JSON", `<html>`, "", "narrator: unreadable answer"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			narrator := compatibleDouble(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, c.answer)
			})
			got, err := narrator.Narrate(t.Context(), cleared("b"))
			switch {
			case c.message == "" && (err != nil || got != c.want):
				t.Fatalf("got %q, %v", got, err)
			case c.message != "" && (err == nil || err.Error() != c.message || got != ""):
				t.Fatalf("got %q, %v", got, err)
			}
		})
	}
}

func TestCompatibleRetriesOnceWhatTheClaudeAdapterRetries(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		status int
		calls  int32
	}{{400, 1}, {401, 1}, {429, 2}, {500, 2}, {503, 2}} {
		var calls atomic.Int32
		narrator := compatibleDouble(t, func(w http.ResponseWriter, _ *http.Request) {
			calls.Add(1)
			w.Header().Set("Retry-After-Ms", "1")
			w.WriteHeader(c.status)
		})
		if _, err := narrator.Narrate(t.Context(), cleared("b")); err == nil {
			t.Fatalf("%d: expected the error", c.status)
		}
		if calls.Load() != c.calls {
			t.Fatalf("%d: %d calls, want %d", c.status, calls.Load(), c.calls)
		}
	}
}

func TestCompatibleSucceedsOnTheRetry(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	narrator := compatibleDouble(t, func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After-Ms", "1")
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = io.WriteString(w, completion("stop", `"ok"`))
	})
	got, err := narrator.Narrate(t.Context(), cleared("b"))
	if err != nil || got != "ok" || calls.Load() != 2 {
		t.Fatalf("%q, %v, %d calls", got, err, calls.Load())
	}
}

func TestCompatibleStopsWithItsContext(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	narrator := compatibleDouble(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		time.Sleep(200 * time.Millisecond)
		_, _ = io.WriteString(w, completion("stop", `"x"`))
	})
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	if _, err := narrator.Narrate(ctx, cleared("b")); err == nil {
		t.Fatal("expected the error")
	}
	if calls.Load() != 1 {
		t.Fatalf("a cancelled call was retried: %d", calls.Load())
	}
}

func TestCompatibleNeverFollowsARedirect(t *testing.T) {
	t.Parallel()
	var reached atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached.Store(true) }))
	t.Cleanup(target.Close)
	narrator := compatibleDouble(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	})
	_, err := narrator.Narrate(t.Context(), cleared("b"))
	if err == nil || err.Error() != "narrator: request failed" {
		t.Fatalf("error = %v", err)
	}
	if reached.Load() {
		t.Fatal("the text and the key reached the redirect target")
	}
}

func TestCompatibleIgnoresProxyVariables(t *testing.T) {
	t.Parallel()
	transport, ok := NewOpenAICompatible("m", environment(nil)).client.Transport.(*http.Transport)
	if !ok || transport.Proxy != nil {
		t.Fatalf("transport = %#v", transport)
	}
}

func TestCompatibleErrorsAreFixedTexts(t *testing.T) {
	t.Parallel()
	cases := map[string]http.HandlerFunc{
		"status": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":{"message":"echo texto sintético synthetic-test-value"}}`)
		},
		"truncated": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, completion("length", `"texto sintético"`))
		},
		"declined": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, completion("content_filter", `"texto sintético"`))
		},
		"unreadable": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, `texto sintético synthetic-test-value`)
		},
	}
	for name, handler := range cases {
		narrator := compatibleDouble(t, handler)
		_, err := narrator.Narrate(t.Context(), cleared("texto sintético"))
		if err == nil {
			t.Fatalf("%s: expected the error", name)
		}
		for _, leak := range []string{"synthetic-test-value", "texto", "127.0.0.1", "chat/completions"} {
			if strings.Contains(err.Error(), leak) {
				t.Fatalf("%s: error leaks %q: %v", name, leak, err)
			}
		}
	}
	// A refused connection holds the URL in the wrapped error; none of it is kept.
	narrator := NewOpenAICompatible("m", environment(map[string]string{
		"SIPGES_ANALYST_BASE_URL": "http://127.0.0.1:1", "SIPGES_ANALYST_API_KEY": "synthetic-test-value",
	}))
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	_, err := narrator.Narrate(ctx, cleared("texto sintético"))
	if err == nil || strings.Contains(err.Error(), "127.0.0.1") || strings.Contains(err.Error(), "synthetic-test-value") {
		t.Fatalf("error = %v", err)
	}
}

func TestCompatibleRefusesAnOversizedAnswer(t *testing.T) {
	t.Parallel()
	narrator := compatibleDouble(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, completion("stop", `"`+strings.Repeat("x", 2_000_000)+`"`))
	})
	if _, err := narrator.Narrate(t.Context(), cleared("b")); err == nil {
		t.Fatal("expected the error")
	}
}

func TestCompatibleTrimsAsJavaScript(t *testing.T) {
	t.Parallel()
	narrator := compatibleDouble(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, completion("stop", `"\u0085 x \ufeff"`))
	})
	got, err := narrator.Narrate(t.Context(), cleared("b"))
	if err != nil || got != "\u0085 x" {
		t.Fatalf("%q %v", got, err)
	}
}

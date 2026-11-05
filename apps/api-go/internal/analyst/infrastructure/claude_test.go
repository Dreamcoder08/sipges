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
	return NewClaude("claude-opus-5-5", environment(map[string]string{
		"ANTHROPIC_BASE_URL": srv.URL, "ANTHROPIC_API_KEY": "synthetic-test-value",
	}))
}

func environment(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

func TestNameIsTheOneTypeScriptAnswers(t *testing.T) {
	t.Parallel()
	if got := NewClaude("claude-opus-5-5", environment(nil)).Name(); got != "claude:claude-opus-5-5" {
		t.Fatalf("name = %q", got)
	}
}

func TestNarrateSendsOnlyTheBriefingWithFallbacks(t *testing.T) {
	t.Parallel()
	var (
		path, beta, key, query, version string
		body                            map[string]any
		raw                             []byte
	)
	claude := double(t, func(w http.ResponseWriter, r *http.Request) {
		path, query, beta, key = r.URL.Path, r.URL.RawQuery, r.Header.Get("anthropic-beta"), r.Header.Get("Authorization")
		version = r.Header.Get("anthropic-version")
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
	if path != "/v1/messages" || query != "" || version != "2026-10-21" || beta != "server-side-fallback-2026-07-01" || key != "Bearer synthetic-test-value" {
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

func TestNarrateRetriesWhatTypeScriptRetries(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name        string
		status      int
		shouldRetry string
		calls       int32
	}{
		{name: "bad request", status: 400, calls: 1},
		{name: "unauthorised", status: 401, calls: 1},
		{name: "not found", status: 404, calls: 1},
		{name: "timeout", status: 408, calls: 2},
		{name: "conflict", status: 409, calls: 2},
		{name: "rate limit", status: 429, calls: 2},
		{name: "server error", status: 500, calls: 2},
		{name: "unavailable", status: 503, calls: 2},
		{name: "told not to", status: 503, shouldRetry: "false", calls: 1},
		{name: "told to", status: 400, shouldRetry: "true", calls: 2},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			var calls atomic.Int32
			claude := double(t, func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				w.Header().Set("Retry-After-Ms", "1")
				if c.shouldRetry != "" {
					w.Header().Set("X-Should-Retry", c.shouldRetry)
				}
				w.WriteHeader(c.status)
			})
			if _, err := claude.Narrate(t.Context(), cleared("b")); err == nil {
				t.Fatal("expected the error")
			}
			if calls.Load() != c.calls {
				t.Fatalf("calls = %d", calls.Load())
			}
		})
	}
}

func TestRetryWaitIsWhatTypeScriptWaits(t *testing.T) {
	t.Parallel()
	header := func(pairs ...string) http.Header {
		h := http.Header{}
		for i := 0; i < len(pairs); i += 2 {
			h.Set(pairs[i], pairs[i+1])
		}
		return h
	}
	exact := []struct {
		name   string
		header http.Header
		want   time.Duration
	}{
		{"seconds", header("Retry-After", "2"), 2 * time.Second},
		{"above a minute, no cap", header("Retry-After", "120"), 120 * time.Second},
		{"exactly a minute", header("Retry-After", "60"), 60 * time.Second},
		{"milliseconds", header("Retry-After-Ms", "7"), 7 * time.Millisecond},
		{"milliseconds win", header("Retry-After-Ms", "7", "Retry-After", "2"), 7 * time.Millisecond},
		{"zero milliseconds fall to seconds", header("Retry-After-Ms", "0", "Retry-After", "1"), time.Second},
	}
	for _, c := range exact {
		if got := retryWait(c.header); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
	backedOff := []struct {
		name   string
		header http.Header
	}{
		{"no header", header()},
		{"zero seconds", header("Retry-After", "0")},
		{"negative", header("Retry-After", "-1")},
		{"not a number or a date", header("Retry-After", "pronto")},
		{"a past date", header("Retry-After", "Wed, 21 Oct 2015 07:28:00 GMT")},
		{"zero everywhere", header("Retry-After-Ms", "0", "Retry-After", "0")},
	}
	for _, c := range backedOff {
		if got := retryWait(c.header); got < 375*time.Millisecond || got > 500*time.Millisecond {
			t.Errorf("%s: got %v", c.name, got)
		}
	}
}

func TestALongRetryAfterOutlastsTheBudget(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	claude := double(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "120")
		w.WriteHeader(http.StatusTooManyRequests)
	})
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	began := time.Now()
	if _, err := claude.Narrate(ctx, cleared("b")); err == nil {
		t.Fatal("expected the error")
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d", calls.Load())
	}
	if took := time.Since(began); took > time.Second {
		t.Fatalf("a wait that cannot fit held the request for %v", took)
	}
}

func TestAWaitThatFitsTheBudgetIsServed(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	claude := double(t, func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After-Ms", "50")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		_, _ = io.WriteString(w, answer("end_turn", `[{"type":"text","text":"x"}]`))
	})
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if got, err := claude.Narrate(ctx, cleared("b")); err != nil || got != "x" {
		t.Fatalf("%q %v", got, err)
	}
}

func TestNarrateSucceedsOnTheRetry(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	claude := double(t, func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After-Ms", "1")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = io.WriteString(w, answer("end_turn", `[{"type":"text","text":"x"}]`))
	})
	if got, err := claude.Narrate(t.Context(), cleared("b")); err != nil || got != "x" {
		t.Fatalf("%q %v", got, err)
	}
}

func TestNarrateRetriesAConnectionError(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	claude := double(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		hijacked, ok := w.(http.Hijacker)
		if !ok {
			t.Error("no hijacker")
			return
		}
		conn, _, err := hijacked.Hijack()
		if err == nil {
			_ = conn.Close()
		}
	})
	if _, err := claude.Narrate(t.Context(), cleared("b")); err == nil {
		t.Fatal("expected the error")
	}
	if calls.Load() != 2 {
		t.Fatalf("calls = %d", calls.Load())
	}
}

func TestNarrateStopsWithItsContext(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	var calls atomic.Int32
	claude := double(t, func(_ http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		<-release
	})
	t.Cleanup(func() { close(release) })
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	if _, err := claude.Narrate(ctx, cleared("b")); err == nil {
		t.Fatal("expected the error")
	}
	if calls.Load() != 1 {
		t.Fatalf("a cancelled call was retried: %d", calls.Load())
	}
}

func TestRequestTimeoutIsBounded(t *testing.T) {
	t.Parallel()
	if requestTimeout <= 0 || requestTimeout > 20*time.Second {
		t.Fatalf("timeout = %v", requestTimeout)
	}
}

func TestCredentials(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"key", map[string]string{"ANTHROPIC_API_KEY": "k"}, "Bearer k"},
		{"token", map[string]string{"ANTHROPIC_AUTH_TOKEN": "t"}, "Bearer t"},
		{"the key wins", map[string]string{"ANTHROPIC_API_KEY": "k", "ANTHROPIC_AUTH_TOKEN": "t"}, "Bearer k"},
		{"trimmed", map[string]string{"ANTHROPIC_API_KEY": " k\n"}, "Bearer k"},
		{"trimmed as JavaScript", map[string]string{"ANTHROPIC_API_KEY": "\ufeffk"}, "Bearer k"},
		{"an empty key is none", map[string]string{"ANTHROPIC_API_KEY": "  ", "ANTHROPIC_AUTH_TOKEN": "t"}, "Bearer t"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			var got string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				got = r.Header.Get("Authorization")
				_, _ = io.WriteString(w, answer("end_turn", `[{"type":"text","text":"x"}]`))
			}))
			t.Cleanup(srv.Close)
			env := map[string]string{"ANTHROPIC_BASE_URL": " " + srv.URL + "/\n"}
			for key, value := range c.env {
				env[key] = value
			}
			if _, err := NewClaude("m", environment(env)).Narrate(t.Context(), cleared("b")); err != nil {
				t.Fatal(err)
			}
			if got != c.want {
				t.Fatalf("authorization = %q", got)
			}
		})
	}
}

func TestNoCredentialSendsNothing(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
	t.Cleanup(srv.Close)
	claude := NewClaude("m", environment(map[string]string{"ANTHROPIC_BASE_URL": srv.URL, "ANTHROPIC_API_KEY": "  "}))
	if _, err := claude.Narrate(t.Context(), cleared("b")); err == nil {
		t.Fatal("expected the error")
	}
	if calls.Load() != 0 {
		t.Fatalf("calls = %d", calls.Load())
	}
}

func TestAnEmptyBaseURLIsTheDefault(t *testing.T) {
	t.Parallel()
	claude := NewClaude("m", environment(map[string]string{"ANTHROPIC_BASE_URL": " "}))
	if claude.endpoint != "https://api.anthropic.com/v1/messages" {
		t.Fatalf("endpoint = %q", claude.endpoint)
	}
}

func TestErrorsHoldNeitherTheKeyNorTheText(t *testing.T) {
	t.Parallel()
	claude := double(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":{"message":"echo texto sintético synthetic-test-value"}}`)
	})
	_, err := claude.Narrate(t.Context(), cleared("texto sintético"))
	if err == nil {
		t.Fatal("expected the error")
	}
	for _, leak := range []string{"synthetic-test-value", "texto", "127.0.0.1"} {
		if strings.Contains(err.Error(), leak) {
			t.Fatalf("error leaks %q: %v", leak, err)
		}
	}
}

func TestAnOversizedAnswerIsRefused(t *testing.T) {
	t.Parallel()
	claude := double(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, answer("end_turn", `[{"type":"text","text":"`+strings.Repeat("x", 2_000_000)+`"}]`))
	})
	if _, err := claude.Narrate(t.Context(), cleared("b")); err == nil {
		t.Fatal("expected the error")
	}
}

func TestNarrateTrimsAsJavaScript(t *testing.T) {
	t.Parallel()
	claude := double(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, answer("end_turn", `[{"type":"text","text":"\u0085 x \ufeff"}]`))
	})
	got, err := claude.Narrate(t.Context(), cleared("b"))
	if err != nil || got != "\u0085 x" {
		t.Fatalf("%q %v", got, err)
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

func TestNarrateRefusesANullAnswer(t *testing.T) {
	t.Parallel()
	claude := double(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `null`)
	})
	if got, err := claude.Narrate(t.Context(), cleared("b")); err == nil {
		t.Fatalf("got %q", got)
	}
}

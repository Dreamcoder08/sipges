package infrastructure

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
)

const validVector = `{"embeddings":[[1,0,0,0,0,0,0,0.5]]}`

func cleared(text string) privacy.Sanitised[string] {
	return privacy.ExemptPayload(text, privacy.ExemptConstant)
}

func fakeOllama(t *testing.T, handler http.HandlerFunc) *Ollama {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	client, err := NewOllama(srv.URL, "fake-embed")
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestEgressIsLocalOnlyForLoopbackHosts(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"http://127.0.0.1:11434":       "local",
		"http://127.200.3.4":           "local",
		"http://localhost:11434":       "local",
		"http://LOCALHOST:11434":       "local",
		"http://[::1]:11434":           "local",
		"http://user:pw@127.0.0.1":     "local",
		"https://embeddings.example":   "external",
		"http://10.0.0.8:11434":        "external",
		"http://0.0.0.0:11434":         "external",
		"http://localhost.example.org": "external",
		"http://127.0.0.1.example.org": "external",
		"http://127.999.0.1":           "external",
		"http://127.0.0.1@example.org": "external",
		"http://localhost@example.org": "external",
		"http://[::ffff:127.0.0.1]":    "external",
		"http://[::2]":                 "external",
		"http://localhoſt":             "external",
	}
	for base, want := range cases {
		client, err := NewOllama(base, "m")
		if err != nil {
			t.Fatalf("%s: %v", base, err)
		}
		if got := client.Egress(); got != want {
			t.Errorf("%s: egress = %q, want %q", base, got, want)
		}
	}
}

func TestModelIsTheConfiguredOne(t *testing.T) {
	t.Parallel()
	client, err := NewOllama("http://127.0.0.1:9", "fake-embed")
	if err != nil {
		t.Fatal(err)
	}
	if client.Model() != "fake-embed" {
		t.Fatalf("model = %q", client.Model())
	}
}

func TestNewOllamaRefusesAnUnusableBase(t *testing.T) {
	t.Parallel()
	if _, err := NewOllama("://", "m"); err == nil {
		t.Fatal("expected an error")
	}
}

func TestEmbedPostsToTheFixedPathAndReturnsTheVector(t *testing.T) {
	t.Parallel()
	var method, path, contentType, query string
	var body map[string]any
	client := fakeOllama(t, func(w http.ResponseWriter, r *http.Request) {
		method, path, contentType, query = r.Method, r.URL.Path, r.Header.Get("Content-Type"), r.URL.RawQuery
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		_, _ = io.WriteString(w, validVector)
	})
	vector, err := client.Embed(t.Context(), cleared("texto sintético <b>"))
	if err != nil {
		t.Fatal(err)
	}
	if method != http.MethodPost || path != "/api/embed" || query != "" || contentType != "application/json" {
		t.Fatalf("request = %s %s?%s %s", method, path, query, contentType)
	}
	if body["model"] != "fake-embed" || body["input"] != "texto sintético <b>" || len(body) != 2 {
		t.Fatalf("body = %v", body)
	}
	if len(vector) != 8 || vector[0] != 1 || vector[7] != 0.5 {
		t.Fatalf("vector = %v", vector)
	}
}

func TestEmbedIgnoresAPathOrQueryInTheBaseURL(t *testing.T) {
	t.Parallel()
	var uri string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uri = r.URL.RequestURI()
		_, _ = io.WriteString(w, validVector)
	}))
	t.Cleanup(srv.Close)
	client, err := NewOllama(srv.URL+"/prefix/?token=x#fragment", "m")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Embed(t.Context(), cleared("t")); err != nil {
		t.Fatal(err)
	}
	if uri != "/api/embed" {
		t.Fatalf("uri = %q", uri)
	}
}

func TestEmbedCutsTheInputAtTwelveThousandCodePoints(t *testing.T) {
	t.Parallel()
	var input string
	client := fakeOllama(t, func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Input string `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		input = body.Input
		_, _ = io.WriteString(w, validVector)
	})
	if _, err := client.Embed(t.Context(), cleared(strings.Repeat("😀", 12_001))); err != nil {
		t.Fatal(err)
	}
	if input != strings.Repeat("😀", 12_000) {
		t.Fatalf("input holds %d bytes", len(input))
	}
}

func TestEmbedRefusesAnythingButAValidVector(t *testing.T) {
	t.Parallel()
	bodies := map[string]string{
		"not json":       `nope`,
		"trailing text":  validVector + ` x`,
		"no embeddings":  `{}`,
		"null":           `{"embeddings":null}`,
		"not an array":   `{"embeddings":"x"}`,
		"empty":          `{"embeddings":[]}`,
		"short vector":   `{"embeddings":[[1,2,3,4,5,6,7]]}`,
		"string entry":   `{"embeddings":[[1,0,0,0,0,0,0,"0"]]}`,
		"null entry":     `{"embeddings":[[1,0,0,0,0,0,0,null]]}`,
		"vector is text": `{"embeddings":["12345678"]}`,
		"other key case": `{"Embeddings":[[1,0,0,0,0,0,0,0]]}`,
		"a top array":    `[[1,0,0,0,0,0,0,0]]`,
	}
	for name, body := range bodies {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			client := fakeOllama(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, body)
			})
			if vector, err := client.Embed(t.Context(), cleared("t")); err == nil {
				t.Fatalf("vector = %v", vector)
			}
		})
	}
}

func TestEmbedUsesTheFirstVector(t *testing.T) {
	t.Parallel()
	client := fakeOllama(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"model":"m","embeddings":[[2,0,0,0,0,0,0,0],["ignored"]]}`)
	})
	vector, err := client.Embed(t.Context(), cleared("t"))
	if err != nil {
		t.Fatal(err)
	}
	if vector[0] != 2 {
		t.Fatalf("vector = %v", vector)
	}
}

func TestEmbedRefusesAFailureStatus(t *testing.T) {
	t.Parallel()
	client := fakeOllama(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, validVector)
	})
	_, err := client.Embed(t.Context(), cleared("secreto sintético"))
	if err == nil || err.Error() != "embeddings: service answered 502" {
		t.Fatalf("error = %v", err)
	}
}

func TestEmbedRefusesAnOversizedResponse(t *testing.T) {
	t.Parallel()
	client := fakeOllama(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"embeddings":[[1,0,0,0,0,0,0,0]],"pad":"`+strings.Repeat("x", 1_500_001)+`"}`)
	})
	_, err := client.Embed(t.Context(), cleared("t"))
	if err == nil || err.Error() != "embeddings: response too large" {
		t.Fatalf("error = %v", err)
	}
}

func TestEmbedAcceptsAResponseAtTheLimit(t *testing.T) {
	t.Parallel()
	const prefix, suffix = `{"embeddings":[[1,0,0,0,0,0,0,0]],"pad":"`, `"}`
	pad := strings.Repeat("x", 1_500_000-len(prefix)-len(suffix))
	client := fakeOllama(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(1_500_000))
		_, _ = io.WriteString(w, prefix+pad+suffix)
	})
	if _, err := client.Embed(t.Context(), cleared("t")); err != nil {
		t.Fatal(err)
	}
}

func TestEmbedNeverFollowsARedirect(t *testing.T) {
	t.Parallel()
	var reached atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached.Store(true) }))
	t.Cleanup(target.Close)
	client := fakeOllama(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/api/embed", http.StatusTemporaryRedirect)
	})
	if _, err := client.Embed(t.Context(), cleared("texto")); err == nil {
		t.Fatal("a redirect must fail the call")
	}
	if reached.Load() {
		t.Fatal("the text reached the redirect target")
	}
}

func TestEmbedRefusesCredentialsInTheBaseURL(t *testing.T) {
	t.Parallel()
	var reached atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached.Store(true) }))
	t.Cleanup(srv.Close)
	client, err := NewOllama(strings.Replace(srv.URL, "http://", "http://user:pw@", 1), "m")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Embed(t.Context(), cleared("t")); err == nil {
		t.Fatal("fetch refuses a URL with credentials; so must this client")
	}
	if reached.Load() {
		t.Fatal("the request left")
	}
}

func TestEmbedErrorsHoldNeitherTheURLNorTheText(t *testing.T) {
	t.Parallel()
	client, err := NewOllama("http://127.0.0.1:9/?token=synthetic-secret", "m")
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Embed(t.Context(), cleared("texto sintético"))
	if err == nil {
		t.Fatal("expected an error")
	}
	if text := err.Error(); strings.Contains(text, "synthetic-secret") || strings.Contains(text, "127.0.0.1") ||
		strings.Contains(text, "texto") {
		t.Fatalf("error leaks: %v", err)
	}
}

func TestClientIgnoresProxyVariables(t *testing.T) {
	t.Parallel()
	client, err := NewOllama("http://127.0.0.1:9", "m")
	if err != nil {
		t.Fatal(err)
	}
	transport, ok := client.client.Transport.(*http.Transport)
	if !ok || transport.Proxy != nil {
		t.Fatal("only the configured base URL may be contacted")
	}
}

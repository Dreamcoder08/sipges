package config

import "testing"

func TestLoadOllamaDefaultsToTheLoopbackServer(t *testing.T) {
	t.Parallel()
	got, err := LoadOllama(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	want := Ollama{BaseURL: "http://127.0.0.1:11434", Model: "nomic-embed-text"}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestLoadOllamaReadsEveryVariable(t *testing.T) {
	t.Parallel()
	got, err := LoadOllama(env(map[string]string{
		"SIPGES_OLLAMA_URL":         "https://embeddings.example.org",
		"SIPGES_OLLAMA_EMBED_MODEL": "synthetic-model",
		"SIPGES_SEMANTIC_SEARCH":    "1",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := Ollama{
		BaseURL: "https://embeddings.example.org", Model: "synthetic-model", Configured: true, SemanticSearch: true,
	}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestLoadOllamaKeepsTheDefaultModelForAnEmptyOne(t *testing.T) {
	t.Parallel()
	got, err := LoadOllama(env(map[string]string{"SIPGES_OLLAMA_EMBED_MODEL": ""}))
	if err != nil {
		t.Fatal(err)
	}
	if got.Model != "nomic-embed-text" {
		t.Fatalf("model = %q", got.Model)
	}
}

func TestLoadOllamaRefusesWhatTypeScriptRefuses(t *testing.T) {
	t.Parallel()
	const notAbsolute = "SIPGES_OLLAMA_URL must be an absolute URL"
	const notHTTP = "SIPGES_OLLAMA_URL must use http or https"
	cases := []struct {
		name, value, message string
	}{
		{name: "empty", value: "", message: notAbsolute},
		{name: "relative", value: "/api", message: notAbsolute},
		{name: "no host", value: "http://", message: notAbsolute},
		{name: "backslash host", value: `http://evil.example\@127.0.0.1/`, message: notAbsolute},
		{name: "file scheme", value: "file:///etc/passwd", message: notHTTP},
		{name: "ftp scheme", value: "ftp://127.0.0.1", message: notHTTP},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			_, err := LoadOllama(env(map[string]string{"SIPGES_OLLAMA_URL": c.value}))
			if err == nil || err.Error() != c.message {
				t.Fatalf("error = %v, want %q", err, c.message)
			}
		})
	}
	if _, err := LoadOllama(env(map[string]string{"SIPGES_SEMANTIC_SEARCH": "yes"})); err == nil {
		t.Fatal("a malformed switch must stop the start")
	}
}

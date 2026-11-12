package config

import (
	"strings"
	"testing"
)

func TestAnalystIsOffUnlessAskedFor(t *testing.T) {
	t.Parallel()
	for _, values := range []map[string]string{nil, {"SIPGES_ANALYST_PROVIDER": ""}, {"SIPGES_ANALYST_PROVIDER": "none"}} {
		got, err := LoadAnalyst(env(values))
		if err != nil || got.Enabled {
			t.Fatalf("%v: %+v, %v", values, got, err)
		}
	}
}

func TestAnalystNeedsACredential(t *testing.T) {
	t.Parallel()
	const want = "SIPGES_ANALYST_PROVIDER=anthropic requires ANTHROPIC_API_KEY"
	_, err := LoadAnalyst(env(map[string]string{"SIPGES_ANALYST_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": ""}))
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v", err)
	}
	for _, key := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"} {
		got, err := LoadAnalyst(env(map[string]string{"SIPGES_ANALYST_PROVIDER": "anthropic", key: "synthetic-test-value"}))
		if err != nil || !got.Enabled || got.Model != "claude-opus-5-5" {
			t.Fatalf("%s: %+v, %v", key, got, err)
		}
	}
}

func TestAnalystRefusesWhatTypeScriptRefuses(t *testing.T) {
	t.Parallel()
	cases := []struct {
		values  map[string]string
		message string
	}{
		{map[string]string{"SIPGES_ANALYST_PROVIDER": "otro"}, providerMessage},
		{
			map[string]string{"SIPGES_ANALYST_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "x", "SIPGES_ANALYST_MODEL": "Bad Model!"},
			"SIPGES_ANALYST_MODEL is not a valid model id",
		},
	}
	for _, c := range cases {
		if _, err := LoadAnalyst(env(c.values)); err == nil || err.Error() != c.message {
			t.Fatalf("error = %v", err)
		}
	}
}

func TestAnalystReadsTheModel(t *testing.T) {
	t.Parallel()
	got, err := LoadAnalyst(env(map[string]string{
		"SIPGES_ANALYST_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "x", "SIPGES_ANALYST_MODEL": "claude-synthetic-1",
	}))
	if err != nil || got.Model != "claude-synthetic-1" {
		t.Fatalf("%+v, %v", got, err)
	}
}

const (
	providerMessage = "SIPGES_ANALYST_PROVIDER must be unset, 'none', 'anthropic' or 'openai-compatible'"
	needsBaseURL    = "SIPGES_ANALYST_PROVIDER=openai-compatible requires SIPGES_ANALYST_BASE_URL"
	badBaseURL      = "SIPGES_ANALYST_BASE_URL must be https, or http on a loopback host"
	needsAPIKey     = "SIPGES_ANALYST_PROVIDER=openai-compatible requires SIPGES_ANALYST_API_KEY"
	needsModel      = "SIPGES_ANALYST_PROVIDER=openai-compatible requires SIPGES_ANALYST_MODEL"
	badModel        = "SIPGES_ANALYST_MODEL is not a valid model id"
)

func compatible(extra map[string]string) map[string]string {
	values := map[string]string{
		"SIPGES_ANALYST_PROVIDER": "openai-compatible",
		"SIPGES_ANALYST_BASE_URL": "https://api.example.test",
		"SIPGES_ANALYST_API_KEY":  "synthetic-test-value",
		"SIPGES_ANALYST_MODEL":    "deepseek-chat",
	}
	for key, value := range extra {
		values[key] = value
	}
	return values
}

func TestAnalystOpenAICompatibleRefusesWhatS3Names(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		values  map[string]string
		message string
	}{
		{"unknown provider", map[string]string{"SIPGES_ANALYST_PROVIDER": "otro"}, providerMessage},
		{"no base URL", compatible(map[string]string{"SIPGES_ANALYST_BASE_URL": ""}), needsBaseURL},
		{"blank base URL", compatible(map[string]string{"SIPGES_ANALYST_BASE_URL": "  "}), needsBaseURL},
		{"plain http", compatible(map[string]string{"SIPGES_ANALYST_BASE_URL": "http://api.example.test"}), badBaseURL},
		{"not a URL", compatible(map[string]string{"SIPGES_ANALYST_BASE_URL": "api.example.test"}), badBaseURL},
		{"other scheme", compatible(map[string]string{"SIPGES_ANALYST_BASE_URL": "ftp://127.0.0.1"}), badBaseURL},
		{"no host", compatible(map[string]string{"SIPGES_ANALYST_BASE_URL": "https://"}), badBaseURL},
		{"a lookalike of localhost", compatible(map[string]string{"SIPGES_ANALYST_BASE_URL": "http://localhost.example.test"}), badBaseURL},
		{"userinfo before the host", compatible(map[string]string{"SIPGES_ANALYST_BASE_URL": "http://127.0.0.1@evil.example.test"}), badBaseURL},
		{"fragment trick", compatible(map[string]string{"SIPGES_ANALYST_BASE_URL": "http://evil.example.test#@localhost"}), badBaseURL},
		{"no key", compatible(map[string]string{"SIPGES_ANALYST_API_KEY": ""}), needsAPIKey},
		{"blank key", compatible(map[string]string{"SIPGES_ANALYST_API_KEY": " "}), needsAPIKey},
		{"no model", compatible(map[string]string{"SIPGES_ANALYST_MODEL": ""}), needsModel},
		{"unset model", map[string]string{
			"SIPGES_ANALYST_PROVIDER": "openai-compatible", "SIPGES_ANALYST_BASE_URL": "https://api.example.test",
			"SIPGES_ANALYST_API_KEY": "k",
		}, needsModel},
		{"model with a space", compatible(map[string]string{"SIPGES_ANALYST_MODEL": "bad model"}), badModel},
		{"model too long", compatible(map[string]string{"SIPGES_ANALYST_MODEL": strings.Repeat("a", 129)}), badModel},
		{"model with a newline at the end", compatible(map[string]string{"SIPGES_ANALYST_MODEL": "m\n"}), badModel},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			if _, err := LoadAnalyst(env(c.values)); err == nil || err.Error() != c.message {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestAnalystOpenAICompatibleReadsItsSettings(t *testing.T) {
	t.Parallel()
	for _, model := range []string{"deepseek-chat", "deepseek/deepseek-chat", "llama3.1:8b", "GPT_4.1", strings.Repeat("a", 128), "a"} {
		got, err := LoadAnalyst(env(compatible(map[string]string{"SIPGES_ANALYST_MODEL": model})))
		if err != nil || !got.Enabled || got.Provider != "openai-compatible" || got.Model != model {
			t.Fatalf("%s: %+v, %v", model, got, err)
		}
	}
}

func TestAnalystOpenAICompatibleAllowsLoopbackWithoutAKey(t *testing.T) {
	t.Parallel()
	for _, base := range []string{
		"http://localhost:11434", "http://LOCALHOST", "http://127.0.0.1:11434/v1", "http://127.8.9.10", "http://[::1]:8080",
		"https://127.0.0.1",
	} {
		got, err := LoadAnalyst(env(compatible(map[string]string{
			"SIPGES_ANALYST_BASE_URL": base, "SIPGES_ANALYST_API_KEY": "", "SIPGES_ANALYST_MODEL": "llama3.1:8b",
		})))
		if err != nil || !got.Enabled {
			t.Fatalf("%s: %+v, %v", base, got, err)
		}
	}
}

func TestAnalystOpenAICompatibleNeedsAKeyOffLoopback(t *testing.T) {
	t.Parallel()
	_, err := LoadAnalyst(env(compatible(map[string]string{
		"SIPGES_ANALYST_BASE_URL": "https://api.example.test", "SIPGES_ANALYST_API_KEY": "",
	})))
	if err == nil || err.Error() != needsAPIKey {
		t.Fatalf("error = %v", err)
	}
}

func TestAnalystAnthropicIsUnchangedByTheNewProvider(t *testing.T) {
	t.Parallel()
	got, err := LoadAnalyst(env(map[string]string{
		"SIPGES_ANALYST_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "synthetic-test-value",
		"SIPGES_ANALYST_BASE_URL": "http://insecure.example.test", "SIPGES_ANALYST_API_KEY": "",
	}))
	if err != nil || !got.Enabled || got.Provider != "anthropic" || got.Model != "claude-opus-5-5" {
		t.Fatalf("%+v, %v", got, err)
	}
	// Its model keeps the narrower grammar of the Claude ids.
	_, err = LoadAnalyst(env(map[string]string{
		"SIPGES_ANALYST_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": "x", "SIPGES_ANALYST_MODEL": "deepseek/deepseek-chat",
	}))
	if err == nil || err.Error() != badModel {
		t.Fatalf("error = %v", err)
	}
}

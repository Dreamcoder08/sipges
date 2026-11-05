package config

import "testing"

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
		{map[string]string{"SIPGES_ANALYST_PROVIDER": "otro"}, "SIPGES_ANALYST_PROVIDER must be unset, 'none' or 'anthropic'"},
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

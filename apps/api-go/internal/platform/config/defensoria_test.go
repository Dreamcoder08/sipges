package config

import "testing"

func TestLoadDefensoriaURLDefaultsToTheOfficialEndpoint(t *testing.T) {
	t.Parallel()
	for _, lookup := range []Lookup{env(nil), env(map[string]string{"SIPGES_DEFENSORIA_URL": ""})} {
		got, err := LoadDefensoriaURL(lookup)
		if err != nil || got != "" {
			t.Fatalf("got %q, %v; want the official endpoint (empty)", got, err)
		}
	}
}

func TestLoadDefensoriaURLAcceptsASyntheticDouble(t *testing.T) {
	t.Parallel()
	const double = "http://127.0.0.1:4555/wp-json/wp/v2/posts"
	got, err := LoadDefensoriaURL(env(map[string]string{"SIPGES_DEFENSORIA_URL": double}))
	if err != nil || got != double {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestLoadDefensoriaURLRefusesWhatTypeScriptRefuses(t *testing.T) {
	t.Parallel()
	const message = "SIPGES_DEFENSORIA_URL must be an absolute http or https URL without a query"
	for _, value := range []string{"not a url", "/wp-json", "file:///tmp/posts", "https://double.example/posts?x=1", "http://a/#f"} {
		_, err := LoadDefensoriaURL(env(map[string]string{"SIPGES_DEFENSORIA_URL": value}))
		if err == nil || err.Error() != message {
			t.Fatalf("%q: error = %v, want %q", value, err, message)
		}
	}
}

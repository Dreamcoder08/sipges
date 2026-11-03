package config

import (
	"slices"
	"strings"
	"testing"
)

func env(values map[string]string) Lookup {
	return func(key string) (string, bool) {
		v, ok := values[key]
		return v, ok
	}
}

const synthURL = "postgres://sipges_test@127.0.0.1:55439/sipges_test"

func TestLoadDefaults(t *testing.T) {
	t.Parallel()
	cfg, err := Load(env(map[string]string{"SIPGES_DATABASE_URL": synthURL}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "127.0.0.1" || cfg.Port != 8000 || !cfg.AccessLog || len(cfg.AllowedHosts) != 0 || cfg.DatabaseURL != synthURL {
		t.Fatalf("defaults = %+v", cfg)
	}
}

func TestLoadReadsEveryVariable(t *testing.T) {
	t.Parallel()
	cfg, err := Load(env(map[string]string{
		"SIPGES_DATABASE_URL":  synthURL,
		"SIPGES_HOST":          "0.0.0.0",
		"SIPGES_PORT":          "8080",
		"SIPGES_ALLOWED_HOSTS": " Sipges.Example.org , localhost ,",
		"SIPGES_ACCESS_LOG":    "0",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "0.0.0.0" || cfg.Port != 8080 || cfg.AccessLog || !slices.Equal(cfg.AllowedHosts, []string{"sipges.example.org", "localhost"}) {
		t.Fatalf("cfg = %+v", cfg)
	}
}

func TestLoadRejectsInvalidValues(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"missing database", map[string]string{}, "SIPGES_DATABASE_URL is required"},
		{"empty database", map[string]string{"SIPGES_DATABASE_URL": ""}, "SIPGES_DATABASE_URL is required"},
		{"port zero", map[string]string{"SIPGES_DATABASE_URL": synthURL, "SIPGES_PORT": "0"}, "SIPGES_PORT must be an integer between 1 and 65535"},
		{"port too big", map[string]string{"SIPGES_DATABASE_URL": synthURL, "SIPGES_PORT": "65536"}, "SIPGES_PORT must be an integer between 1 and 65535"},
		{"port signed", map[string]string{"SIPGES_DATABASE_URL": synthURL, "SIPGES_PORT": "+80"}, "SIPGES_PORT must be an integer between 1 and 65535"},
		{"port text", map[string]string{"SIPGES_DATABASE_URL": synthURL, "SIPGES_PORT": "http"}, "SIPGES_PORT must be an integer between 1 and 65535"},
		{"switch", map[string]string{"SIPGES_DATABASE_URL": synthURL, "SIPGES_ACCESS_LOG": "true"}, "SIPGES_ACCESS_LOG must be unset or exactly '0' or '1'"},
		{"host with port", map[string]string{"SIPGES_DATABASE_URL": synthURL, "SIPGES_ALLOWED_HOSTS": "a.example:443"}, "SIPGES_ALLOWED_HOSTS has an invalid host name: a.example:443"},
		{"host label", map[string]string{"SIPGES_DATABASE_URL": synthURL, "SIPGES_ALLOWED_HOSTS": "-bad.example"}, "SIPGES_ALLOWED_HOSTS has an invalid host name: -bad.example"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, err := Load(env(tc.env))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestLoadErrorNeverEchoesTheDatabaseURL(t *testing.T) {
	t.Parallel()
	_, err := Load(env(map[string]string{"SIPGES_DATABASE_URL": "postgres://u:synthetic-secret@h/db", "SIPGES_PORT": "x"}))
	if err == nil || strings.Contains(err.Error(), "synthetic-secret") {
		t.Fatalf("err = %v", err)
	}
}

func TestLoadRequiresMFAByDefault(t *testing.T) {
	t.Parallel()
	for value, want := range map[string]bool{"": true, "1": true, "0": false} {
		vars := map[string]string{"SIPGES_DATABASE_URL": synthURL}
		if value != "" {
			vars["SIPGES_REQUIRE_MFA"] = value
		}
		cfg, err := Load(env(vars))
		if err != nil || cfg.RequireMFA != want {
			t.Errorf("SIPGES_REQUIRE_MFA=%q: %v %v", value, cfg.RequireMFA, err)
		}
	}
	if _, err := Load(env(map[string]string{"SIPGES_DATABASE_URL": synthURL, "SIPGES_REQUIRE_MFA": "yes"})); err == nil ||
		!strings.Contains(err.Error(), "SIPGES_REQUIRE_MFA must be unset or exactly '0' or '1'") {
		t.Errorf("invalid switch: %v", err)
	}
}

// Same rules and messages as parseGoogle in apps/api/src/platform/config.ts.
func TestLoadGoogleProvider(t *testing.T) {
	t.Parallel()
	cases := []struct {
		vars    map[string]string
		enabled bool
		err     string
	}{
		{map[string]string{}, false, ""},
		{map[string]string{"SIPGES_GOOGLE_CLIENT_ID": " id ", "SIPGES_GOOGLE_CLIENT_SECRET": "synthetic"}, true, ""},
		{map[string]string{"SIPGES_GOOGLE_CLIENT_ID": "  ", "SIPGES_GOOGLE_CLIENT_SECRET": ""}, false, ""},
		{map[string]string{"SIPGES_GOOGLE_CLIENT_ID": "id"}, false, "Set both SIPGES_GOOGLE_CLIENT_ID and SIPGES_GOOGLE_CLIENT_SECRET, or neither"},
		{map[string]string{"SIPGES_GOOGLE_ADMIN_EMAIL": "a@example.org"}, false, "SIPGES_GOOGLE_ADMIN_EMAIL requires a Google OAuth client"},
	}
	for _, c := range cases {
		c.vars["SIPGES_DATABASE_URL"] = synthURL
		cfg, err := Load(env(c.vars))
		switch {
		case c.err == "" && (err != nil || cfg.GoogleEnabled != c.enabled):
			t.Errorf("%v: enabled=%v err=%v", c.vars, cfg.GoogleEnabled, err)
		case c.err != "" && (err == nil || !strings.Contains(err.Error(), c.err)):
			t.Errorf("%v: err=%v, want %q", c.vars, err, c.err)
		}
		if err != nil && strings.Contains(err.Error(), "synthetic") {
			t.Errorf("error echoes the secret: %v", err)
		}
	}
}

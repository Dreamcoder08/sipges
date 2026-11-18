package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

func lookupOf(env map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		v, ok := env[key]
		return v, ok
	}
}

func TestParseSettingsDefaultsFollowTheDesktopLauncher(t *testing.T) {
	s, err := parseSettings(nil, lookupOf(map[string]string{"HOME": "/home/u", "SIPGES_PG_BIN": "/pg/bin"}), "/opt/sipges")
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && s.state != filepath.Join("/home/u", ".local", "share", "sipges-local") {
		t.Errorf("state = %q, want the launcher's ~/.local/share/sipges-local", s.state)
	}
	if s.pgBin != "/pg/bin" || s.port != 8000 {
		t.Errorf("pgBin %q port %d", s.pgBin, s.port)
	}
	if s.apiBin != filepath.Join("/opt/sipges", program("api")) || s.migrations != filepath.Join("/opt/sipges", "migrations") {
		t.Errorf("api %q migrations %q: want next to the executable", s.apiBin, s.migrations)
	}
}

func TestParseSettingsFlagsWinOverTheEnvironment(t *testing.T) {
	env := map[string]string{"SIPGES_DESKTOP_STATE": "/env/state", "SIPGES_PG_BIN": "/env/bin"}
	s, err := parseSettings([]string{"--state", "/flag/state", "--pg-bin", "/flag/bin", "--port", "8123"}, lookupOf(env), "/x")
	if err != nil {
		t.Fatal(err)
	}
	if s.state != "/flag/state" || s.pgBin != "/flag/bin" || s.port != 8123 {
		t.Fatalf("settings %+v", s)
	}
	s, err = parseSettings(nil, lookupOf(env), "/x")
	if err != nil || s.state != "/env/state" || s.pgBin != "/env/bin" {
		t.Fatalf("settings %+v, %v", s, err)
	}
}

func TestParseSettingsRequiresTheBinariesFolder(t *testing.T) {
	_, err := parseSettings(nil, lookupOf(map[string]string{"HOME": "/home/u"}), "/x")
	if err == nil || !strings.Contains(userMessage(err), "ejecutables de PostgreSQL") {
		t.Fatalf("err %v, message %q", err, userMessage(err))
	}
}

func TestReadSecretsNeedsTheLauncherFiles(t *testing.T) {
	state := t.TempDir()
	_, err := readSecrets(state)
	if err == nil || !strings.Contains(userMessage(err), "data-key") {
		t.Fatalf("missing data-key: %v, %q", err, userMessage(err))
	}
	writeFile(t, filepath.Join(state, "data-key"), "c3ludGhldGljLWRhdGEta2V5LTMyLWJ5dGVzLXh4eHg=\n")
	writeFile(t, filepath.Join(state, "admin-password"), "   \n")
	_, err = readSecrets(state)
	if err == nil || !strings.Contains(userMessage(err), "admin-password") {
		t.Fatalf("blank admin-password: %v, %q", err, userMessage(err))
	}
}

func TestReadSecretsTrimsTheLauncherFilesAndKeepsDatabasePasswords(t *testing.T) {
	state := t.TempDir()
	writeFile(t, filepath.Join(state, "data-key"), "c3ludGhldGljLWRhdGEta2V5LTMyLWJ5dGVzLXh4eHg=\n")
	writeFile(t, filepath.Join(state, "admin-password"), "SyntheticAdmin1\r\n")
	first, err := readSecrets(state)
	if err != nil {
		t.Fatal(err)
	}
	if first.dataKey != "c3ludGhldGljLWRhdGEta2V5LTMyLWJ5dGVzLXh4eHg=" || first.adminPassword != "SyntheticAdmin1" {
		t.Fatalf("launcher secrets not trimmed: %+v", first)
	}
	if len(first.pgSuper) < 32 || len(first.pgApp) < 32 || first.pgSuper == first.pgApp {
		t.Fatalf("database passwords must be long and distinct: %q %q", first.pgSuper, first.pgApp)
	}
	for _, name := range []string{superPasswordFile, appPasswordFile} {
		info, err := os.Stat(filepath.Join(state, name))
		if err != nil {
			t.Fatal(err)
		}
		if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
			t.Errorf("%s mode %v, want 0600", name, info.Mode().Perm())
		}
	}
	second, err := readSecrets(state)
	if err != nil || second != first {
		t.Fatalf("a second read must keep the passwords: %+v vs %+v (%v)", second, first, err)
	}
}

// The local install creates the roles in deploy/local/db-init/10-roles.sh; the desktop must
// create the same ones with the same attributes, or migrations and RLS would behave differently.
func TestRolesMatchTheLocalInstall(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "deploy", "local", "db-init", "10-roles.sh"))
	if err != nil {
		t.Fatal(err)
	}
	script := string(body)
	for _, fragment := range []string{
		"CREATE ROLE " + appRole + " LOGIN PASSWORD :'app_password' " + appRoleAttributes + ";",
		"CREATE ROLE mascli_tenant " + tenantRoleAttributes + ";",
		"CREATE ROLE sipges_tenant " + tenantRoleAttributes + ";",
		grantTenantRoles + ";",
		"CREATE DATABASE " + appDatabase + " OWNER " + appRole + ";",
		revokePublic + ";",
	} {
		if !strings.Contains(script, fragment) {
			t.Errorf("10-roles.sh no longer has %q: update the desktop provisioning with it", fragment)
		}
	}
	if !slices.Equal(tenantRoles, []string{"mascli_tenant", "sipges_tenant"}) {
		t.Errorf("tenant roles %v", tenantRoles)
	}
}

func TestAPIEnvironmentOverridesInheritedValues(t *testing.T) {
	base := []string{"PATH=/bin", "SIPGES_DATABASE_URL=postgres://elsewhere", "SIPGES_PORT=1", "SIPGES_REQUIRE_MFA=0"}
	s := settings{state: "/state", port: 8000, migrations: "/m"}
	sec := secrets{dataKey: "key", adminPassword: "pw"}
	env := apiEnv(base, s, sec, "postgres://local")
	want := map[string]string{
		"PATH":                  "/bin",
		"SIPGES_REQUIRE_MFA":    "0",
		"SIPGES_DATABASE_URL":   "postgres://local",
		"SIPGES_DATA_KEY":       "key",
		"SIPGES_ADMIN_PASSWORD": "pw",
		"SIPGES_HOST":           "127.0.0.1",
		"SIPGES_PORT":           "8000",
		"SIPGES_COOKIE_SECURE":  "0",
		"SIPGES_UPLOAD_DIR":     filepath.Join("/state", "uploads"),
		"SIPGES_MIGRATIONS_DIR": "/m",
		"SIPGES_ALLOWED_HOSTS":  "localhost,127.0.0.1",
	}
	got := map[string]string{}
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		if _, dup := got[k]; dup {
			t.Errorf("%s set twice", k)
		}
		got[k] = v
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	kept := apiEnv([]string{"SIPGES_ALLOWED_HOSTS=sipges.local"}, s, sec, "u")
	if !slices.Contains(kept, "SIPGES_ALLOWED_HOSTS=sipges.local") {
		t.Errorf("an explicit SIPGES_ALLOWED_HOSTS must be kept: %v", kept)
	}
}

func TestUserMessageIsSpanishForUnknownFailures(t *testing.T) {
	if got := userMessage(errors.New("boom")); !strings.Contains(got, "SIPGES no pudo iniciar") {
		t.Fatalf("message %q", got)
	}
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

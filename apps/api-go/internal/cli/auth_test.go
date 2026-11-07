package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	syntheticPassword = "synthetic-password-01"
	syntheticCookie   = "c0ffee-synthetic-session"
	syntheticSecret   = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
)

func (h *harness) signIn() {
	h.t.Helper()
	if got := h.run(syntheticPassword+"\n\n", "login", "--username", "ana"); got.code != ExitOK {
		h.t.Fatalf("login: %+v", got)
	}
}

// fakeLogin answers POST /login and sets the session, and leaves the rest to next.
func fakeLogin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/login" {
			http.SetCookie(w, &http.Cookie{Name: "sipges_session", Value: syntheticCookie, Path: "/"})
			jsonAnswer(w, http.StatusOK, `{"ok":true,"name":"Ana","role":"admin"}`)
			return
		}
		if next != nil {
			next(w, r)
		}
	}
}

func TestLoginKeepsThePasswordOutOfEverything(t *testing.T) {
	var form string
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		form = string(body)
		if r.Header.Get("Origin") != "http://"+r.Host {
			t.Errorf("Origin = %q", r.Header.Get("Origin"))
		}
		http.SetCookie(w, &http.Cookie{Name: "sipges_session", Value: syntheticCookie, Path: "/"})
		jsonAnswer(w, http.StatusOK, `{"ok":true,"name":"Ana","role":"admin"}`)
	})
	got := h.run(syntheticPassword+"\n123456\n", "login", "--username", "ana", "--json")
	if got.code != ExitOK {
		t.Fatalf("%+v", got)
	}
	if !strings.Contains(form, "password="+syntheticPassword) || !strings.Contains(form, "otp=123456") {
		t.Fatalf("form = %q", form)
	}
	if strings.Contains(got.stdout+got.stderr, syntheticPassword) {
		t.Fatal("the password reached the output")
	}
	info, err := os.Stat(h.session)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("session file mode %v", info.Mode().Perm())
	}
	saved, _ := os.ReadFile(h.session)
	if strings.Contains(string(saved), syntheticPassword) || !strings.Contains(string(saved), syntheticCookie) {
		t.Fatalf("session file = %s", saved)
	}
	if strings.Contains(got.stdout, syntheticCookie) {
		t.Fatal("the session cookie reached the output")
	}
}

func TestPasswordFromTheEnvironmentLeavesStdinForTheCode(t *testing.T) {
	var form string
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		form = string(body)
		jsonAnswer(w, http.StatusUnauthorized, `{"detail":"Credenciales inválidas"}`)
	})
	h.env["SIPGES_PASSWORD"] = syntheticPassword
	got := h.run("654321\n", "login", "--username", "ana", "--json")
	if got.code != ExitAuth || !strings.Contains(form, "otp=654321") {
		t.Fatalf("%+v form=%q", got, form)
	}
	if _, err := os.Stat(h.session); err == nil {
		t.Fatal("a refused login saved a session")
	}
}

func TestCredentialsHaveNoFlags(t *testing.T) {
	h := newHarness(t, nil)
	for _, flagName := range []string{"--password", "--totp", "--otp", "--cookie", "--token"} {
		if got := h.run("", "login", "--username", "ana", flagName, "x"); got.code != ExitUsage {
			t.Errorf("%s: exit %d", flagName, got.code)
		}
	}
}

func TestLoginWithASecretFileTriesTheNextStepOnce(t *testing.T) {
	var codes []string
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		codes = append(codes, r.PostForm.Get("otp"))
		if len(codes) == 1 {
			jsonAnswer(w, http.StatusUnauthorized, `{"detail":"`+badOTP+`"}`)
			return
		}
		jsonAnswer(w, http.StatusOK, `{"ok":true}`)
	})
	secret := filepath.Join(t.TempDir(), "totp")
	if err := os.WriteFile(secret, []byte(syntheticSecret+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	h.env["SIPGES_PASSWORD"] = syntheticPassword
	got := h.run("", "login", "--username", "ana", "--totp-secret-file", secret)
	if got.code != ExitOK || len(codes) != 2 || codes[0] == codes[1] {
		t.Fatalf("%+v codes=%v", got, codes)
	}
}

func TestASecretFileOthersCanReadIsRefused(t *testing.T) {
	h := newHarness(t, nil)
	secret := filepath.Join(t.TempDir(), "totp")
	if err := os.WriteFile(secret, []byte(syntheticSecret), 0o640); err != nil {
		t.Fatal(err)
	}
	h.env["SIPGES_PASSWORD"] = syntheticPassword
	if got := h.run("", "login", "--username", "ana", "--totp-secret-file", secret); got.code != ExitLocal {
		t.Fatalf("%+v", got)
	}
}

func TestSignInCommandsRefuseWhatTheyWouldIgnore(t *testing.T) {
	h := newHarness(t, fakeLogin(func(w http.ResponseWriter, _ *http.Request) { jsonAnswer(w, http.StatusOK, `{}`) }))
	h.env["SIPGES_PASSWORD"] = syntheticPassword
	for _, args := range [][]string{
		{"login", "--username", "ana", "--project", "ACME/P1"},
		{"login", "--username", "ana", "extra"},
		{"logout", "--project", "ACME/P1"},
		{"logout", "extra"},
		{"session", "extra"},
		{"mfa", "enroll", "--secret-file", filepath.Join(t.TempDir(), "x"), "--project", "ACME/P1"},
		{"project", "switch", "ACME/P1", "--project", "ACME/P2"},
		{"project", "list", "extra"},
	} {
		if got := h.run("", args...); got.code != ExitUsage {
			t.Errorf("%v: %+v", args, got)
		}
	}
}

func TestSessionReportsARefusedProject(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/system/auth/me" {
			jsonAnswer(w, http.StatusOK, `{"username":"ana","full_name":"Ana","role":"admin","active":1}`)
			return
		}
		jsonAnswer(w, http.StatusForbidden, `{"detail":"Seleccione","projects":["ACME/P1"]}`)
	})
	if err := saveSession(h.session, &session{URL: h.api.URL, Cookies: map[string]string{"sipges_session": "s"}}); err != nil {
		t.Fatal(err)
	}
	if got := h.run("", "session", "--project", "NOPE/NOPE", "--json"); got.code != ExitForbidden {
		t.Fatalf("a refused --project was swallowed: %+v", got)
	}
	got := h.run("", "session", "--json")
	data, _ := decode(t, got.stdout)["data"].(map[string]any)
	if got.code != ExitOK || data["choose_project"] == nil {
		t.Fatalf("%+v", got)
	}
}

func TestAPIKeyGoesToItsFileOnly(t *testing.T) {
	var sent map[string]any
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&sent)
		jsonAnswer(w, http.StatusOK, `{"ok":true,"id":"k1","token":"mscli_synthetic"}`)
	})
	file := filepath.Join(t.TempDir(), "key")
	got := h.run("", "apikey", "create", "--name", "bot", "--access", "write", "--secret-file", file, "--json")
	if got.code != ExitOK || sent["name"] != "bot" || sent["access"] != "write" {
		t.Fatalf("%+v %v", got, sent)
	}
	if strings.Contains(got.stdout+got.stderr, "mscli_synthetic") {
		t.Fatal("the key reached the output")
	}
	info, err := os.Stat(file)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("key file: %v %v", info, err)
	}
	if content, _ := os.ReadFile(file); strings.TrimSpace(string(content)) != "mscli_synthetic" {
		t.Fatalf("key file holds %q", content)
	}
	if got := h.run("", "apikey", "create", "--name", "bot"); got.code != ExitUsage {
		t.Fatalf("a key with nowhere to go: %+v", got)
	}
}

func TestTOTPMatchesTheRFCVector(t *testing.T) {
	// RFC 6238 appendix B, SHA-1, time 59: 94287082, of which six digits are kept.
	got, err := totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59/totpPeriod)
	if err != nil || got != "287082" {
		t.Fatalf("code %q, err %v", got, err)
	}
}

func TestMFAEnrolPutsTheSecretInItsFileOnly(t *testing.T) {
	var confirmed string
	h := newHarness(t, fakeLogin(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/system/auth/totp/setup":
			jsonAnswer(w, http.StatusOK, `{"secret":"`+syntheticSecret+`","otpauth_uri":"otpauth://totp/x?secret=`+syntheticSecret+`"}`)
		case "/system/auth/totp/enable":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			confirmed = body["code"]
			jsonAnswer(w, http.StatusOK, `{"ok":true,"totp_enabled":true}`)
		}
	}))
	h.signIn()
	file := filepath.Join(t.TempDir(), "totp")
	got := h.run("", "mfa", "enroll", "--secret-file", file, "--json")
	if got.code != ExitOK || len(confirmed) != 6 {
		t.Fatalf("%+v code=%q", got, confirmed)
	}
	if strings.Contains(got.stdout+got.stderr, syntheticSecret) {
		t.Fatal("the TOTP secret reached the output")
	}
	info, err := os.Stat(file)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("secret file: %v %v", info, err)
	}
	if got := h.run("", "mfa", "enroll", "--secret-file", file); got.code != ExitLocal {
		t.Fatalf("an existing secret file was not refused: %+v", got)
	}
	if got := h.run("", "mfa", "enroll"); got.code != ExitUsage {
		t.Fatalf("enrolment without a file: %+v", got)
	}
}

func TestAFailedEnrolmentLeavesNoSecretFile(t *testing.T) {
	h := newHarness(t, fakeLogin(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/system/auth/totp/setup" {
			jsonAnswer(w, http.StatusOK, `{"secret":"`+syntheticSecret+`"}`)
			return
		}
		jsonAnswer(w, http.StatusUnprocessableEntity, `{"detail":"Código TOTP incorrecto"}`)
	}))
	h.signIn()
	file := filepath.Join(t.TempDir(), "totp")
	if got := h.run("", "mfa", "enroll", "--secret-file", file); got.code != ExitRejected {
		t.Fatalf("%+v", got)
	}
	if _, err := os.Stat(file); err == nil {
		t.Fatal("the secret of a failed enrolment stayed on disk")
	}
}

func TestSessionIsNeverSentToAnotherAddress(t *testing.T) {
	var saw string
	h := newHarness(t, fakeLogin(nil))
	other := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		saw = r.Header.Get("Cookie")
	}))
	defer other.Close()
	h.signIn()
	got := h.run("", "call", "GET", "/health", "--url", other.URL, "--json")
	if got.code != ExitUsage || saw != "" {
		t.Fatalf("%+v cookie=%q", got, saw)
	}
}

func TestPlainHTTPIsOnlyForThisMachine(t *testing.T) {
	h := newHarness(t, nil)
	h.env["SIPGES_URL"] = "http://sipges.example.test"
	h.env["SIPGES_PASSWORD"] = syntheticPassword
	if got := h.run("", "login", "--username", "ana"); got.code != ExitUsage {
		t.Fatalf("%+v", got)
	}
}

func TestASessionFileOthersCanReadIsRefused(t *testing.T) {
	h := newHarness(t, fakeLogin(nil))
	h.signIn()
	if err := os.Chmod(h.session, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := h.run("", "call", "GET", "/health"); got.code != ExitLocal {
		t.Fatalf("%+v", got)
	}
}

func TestLogoutRemovesTheSavedSession(t *testing.T) {
	h := newHarness(t, fakeLogin(func(w http.ResponseWriter, _ *http.Request) {
		jsonAnswer(w, http.StatusOK, `{"ok":true}`)
	}))
	h.signIn()
	if got := h.run("", "logout"); got.code != ExitOK {
		t.Fatalf("%+v", got)
	}
	if _, err := os.Stat(h.session); err == nil {
		t.Fatal("the session file stayed")
	}
}

func TestSessionAsksTheAPI(t *testing.T) {
	signedIn := false
	h := newHarness(t, fakeLogin(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/system/auth/me" && !signedIn:
			jsonAnswer(w, http.StatusOK, `null`)
		case r.URL.Path == "/system/auth/me":
			jsonAnswer(w, http.StatusOK, `{"username":"ana","full_name":"Ana","role":"admin","active":1}`)
		default:
			jsonAnswer(w, http.StatusOK, `{"company_id":"ACME","project_id":"P1","scope":"ACME/P1"}`)
		}
	}))
	if got := h.run("", "session", "--json"); got.code != ExitAuth {
		t.Fatalf("%+v", got)
	}
	signedIn = true
	h.signIn()
	got := h.run("", "session", "--json")
	data, _ := decode(t, got.stdout)["data"].(map[string]any)
	if got.code != ExitOK || data["role"] != "admin" || data["signed_in"] != true {
		t.Fatalf("%+v", got)
	}
	if project, _ := data["project"].(map[string]any); project["scope"] != "ACME/P1" {
		t.Fatalf("%+v", data)
	}
}

func TestProjectSwitchKeepsTheCookieAndReadsItBack(t *testing.T) {
	h := newHarness(t, fakeLogin(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/select-project" {
			_ = r.ParseForm()
			http.SetCookie(w, &http.Cookie{Name: "sipges_scope", Value: r.PostForm.Get("scope"), Path: "/"})
			w.Header().Set("Location", "/")
			w.WriteHeader(http.StatusSeeOther)
			return
		}
		if lines := r.Header.Values("Cookie"); len(lines) != 1 {
			t.Errorf("the API reads one Cookie header, got %d", len(lines))
		}
		scope, err := r.Cookie("sipges_scope")
		if err != nil {
			t.Errorf("no scope cookie on %s", r.URL.Path)
			return
		}
		jsonAnswer(w, http.StatusOK, `{"scope":"`+scope.Value+`"}`)
	}))
	h.signIn()
	got := h.run("", "project", "switch", "ACME/P1", "--json")
	data, _ := decode(t, got.stdout)["data"].(map[string]any)
	if got.code != ExitOK || data["scope"] != "ACME/P1" {
		t.Fatalf("%+v", got)
	}
}

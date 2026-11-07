package cli

import (
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestVerifyRefusesAnythingButASyntheticInstallHere(t *testing.T) {
	h := newHarness(t, fakeLogin(func(http.ResponseWriter, *http.Request) { t.Error("verify reached the API") }))
	if got := h.run("", "verify"); got.code != ExitUsage || !strings.Contains(got.stderr, "--synthetic-target") {
		t.Fatalf("no acknowledgement: %+v", got)
	}
	if got := h.run("", "verify", "--synthetic-target"); got.code != ExitAuth {
		t.Fatalf("no session: %+v", got)
	}
	h.signIn()
	for _, target := range []string{"https://sipges.example.test", "https://192.0.2.10:8443"} {
		saved, err := os.ReadFile(h.session)
		if err != nil {
			t.Fatal(err)
		}
		moved := strings.ReplaceAll(string(saved), h.api.URL, target)
		if err := os.WriteFile(h.session, []byte(moved), 0o600); err != nil {
			t.Fatal(err)
		}
		delete(h.env, "SIPGES_URL")
		if got := h.run("", "verify", "--synthetic-target"); got.code != ExitUsage {
			t.Fatalf("%s: %+v", target, got)
		}
		h.env["SIPGES_URL"] = h.api.URL
		if err := os.WriteFile(h.session, saved, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestVerifyFailsWhenTheAPIMisbehaves(t *testing.T) {
	// An API that lets everyone in: the anonymous part must say so and the run must fail.
	h := newHarness(t, fakeLogin(func(w http.ResponseWriter, _ *http.Request) { jsonAnswer(w, http.StatusOK, `{"ok":true}`) }))
	h.signIn()
	got := h.run("", "verify", "--synthetic-target")
	if got.code != ExitFailed || !strings.Contains(got.stdout, "FAIL anonymous: data asks for a session") {
		t.Fatalf("%+v", got)
	}
	if !strings.Contains(got.stdout, "PASS anonymous: health answers") {
		t.Fatalf("a passing check is not printed: %s", got.stdout)
	}
	got = h.run("", "verify", "--synthetic-target", "--json")
	body := decode(t, got.stdout)
	data, _ := body["data"].(map[string]any)
	checks, _ := data["checks"].([]any)
	if got.code != ExitFailed || body["ok"] != false || len(checks) == 0 || data["failed"] == float64(0) {
		t.Fatalf("%+v", got)
	}
	if strings.Contains(got.stdout, syntheticCookie) {
		t.Fatal("a credential reached the verdict")
	}
}

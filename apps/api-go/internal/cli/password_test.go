package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

const syntheticNewPassword = "synthetic-changed-02"

func TestPasswordSendsBothLinesAndKeepsThemOutOfEverything(t *testing.T) {
	var method, path, origin, cookie, contentType string
	var body map[string]string
	h := newHarness(t, fakeLogin(func(w http.ResponseWriter, r *http.Request) {
		method, path, origin, contentType = r.Method, r.URL.Path, r.Header.Get("Origin"), r.Header.Get("Content-Type")
		if c, err := r.Cookie("sipges_session"); err == nil {
			cookie = c.Value
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		w.WriteHeader(http.StatusNoContent)
	}))
	h.signIn()
	got := h.run(syntheticPassword+"\n"+syntheticNewPassword+"\n", "password", "--json")
	if got.code != ExitOK {
		t.Fatalf("%+v", got)
	}
	if method != http.MethodPost || path != "/system/auth/password" || cookie != syntheticCookie ||
		origin != h.api.URL || contentType != "application/json" {
		t.Fatalf("sent %s %s origin=%q cookie=%q type=%q", method, path, origin, cookie, contentType)
	}
	if body["current_password"] != syntheticPassword || body["new_password"] != syntheticNewPassword || len(body) != 2 {
		t.Fatalf("body = %v", body)
	}
	if strings.Contains(got.stdout+got.stderr, syntheticPassword) || strings.Contains(got.stdout+got.stderr, syntheticNewPassword) {
		t.Fatal("a password reached the output")
	}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(got.stdout), &envelope); err != nil || envelope["ok"] != true || envelope["status"] != float64(204) {
		t.Fatalf("stdout = %s", got.stdout)
	}
}

func TestPasswordHasNoFlagsForThePasswords(t *testing.T) {
	h := newHarness(t, nil)
	for _, flagName := range []string{"--password", "--current-password", "--new-password", "--current", "--new"} {
		if got := h.run("a\nb\n", "password", flagName, "x"); got.code != ExitUsage {
			t.Errorf("%s: exit %d", flagName, got.code)
		}
	}
}

func TestPasswordNeedsBothLinesBeforeItSendsAnything(t *testing.T) {
	sent := false
	h := newHarness(t, fakeLogin(func(http.ResponseWriter, *http.Request) { sent = true }))
	h.signIn()
	for name, stdin := range map[string]string{"nothing": "", "current only": syntheticPassword + "\n", "empty new": syntheticPassword + "\n\n"} {
		if got := h.run(stdin, "password"); got.code != ExitUsage {
			t.Errorf("%s: %+v", name, got)
		}
	}
	if sent {
		t.Fatal("a request went out without both passwords")
	}
}

func TestPasswordReportsTheAPIRefusal(t *testing.T) {
	h := newHarness(t, fakeLogin(func(w http.ResponseWriter, _ *http.Request) {
		jsonAnswer(w, http.StatusBadRequest, `{"detail":"Credenciales inválidas"}`)
	}))
	h.signIn()
	got := h.run("wrong-password\n"+syntheticNewPassword+"\n", "password", "--json")
	if got.code != ExitRejected || !strings.Contains(got.stdout, "Credenciales inválidas") {
		t.Fatalf("%+v", got)
	}
}

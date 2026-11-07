package cli

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// An unusable path is found before the API issues a key that could only be lost.
func TestAKeyWithNowhereToGoIsNeverIssued(t *testing.T) {
	issued := 0
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		issued++
		jsonAnswer(w, http.StatusOK, `{"ok":true,"id":7,"token":"mscli_synthetic"}`)
	})
	file := filepath.Join(t.TempDir(), "missing", "key")
	got := h.run("", "apikey", "create", "--name", "bot", "--secret-file", file, "--json")
	if got.code != ExitLocal || issued != 0 {
		t.Fatalf("exit %d, %d keys issued: %+v", got.code, issued, got)
	}
}

// A refused or failed request leaves no empty key file behind.
func TestARefusedKeyLeavesNoFile(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		jsonAnswer(w, http.StatusConflict, `{"detail":"Ya existe una clave con ese nombre"}`)
	})
	file := filepath.Join(t.TempDir(), "key")
	if got := h.run("", "apikey", "create", "--name", "bot", "--secret-file", file, "--json"); got.code == ExitOK {
		t.Fatalf("%+v", got)
	}
	if _, err := os.Lstat(file); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the key file stayed: %v", err)
	}
}

// A key that cannot be saved cannot be used, so it does not stay alive.
func TestAKeyThatCannotBeSavedIsRevoked(t *testing.T) {
	broken := func(io.Writer, string) error { return errors.New("no space left on device") }
	for name, c := range map[string]struct {
		revokeStatus int
		detail       string
	}{
		"revoked":     {http.StatusOK, "was revoked"},
		"still alive": {http.StatusInternalServerError, "key 7 is still active"},
	} {
		t.Run(name, func(t *testing.T) {
			var revoked string
			h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodDelete {
					revoked = r.URL.Path
					jsonAnswer(w, c.revokeStatus, `{"ok":true}`)
					return
				}
				jsonAnswer(w, http.StatusOK, `{"ok":true,"id":7,"token":"mscli_synthetic"}`)
			})
			previous := writeSecret
			writeSecret = broken
			t.Cleanup(func() { writeSecret = previous })
			file := filepath.Join(t.TempDir(), "key")
			got := h.run("", "apikey", "create", "--name", "bot", "--secret-file", file, "--json")
			body, _ := json.Marshal(decode(t, got.stdout))
			if got.code != ExitLocal || revoked != apiKeysPath+"/7" || !strings.Contains(string(body), c.detail) {
				t.Fatalf("exit %d, revoked %q: %s", got.code, revoked, body)
			}
			if strings.Contains(got.stdout+got.stderr, "mscli_synthetic") {
				t.Fatal("the key reached the output")
			}
			if _, err := os.Lstat(file); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("the key file stayed: %v", err)
			}
		})
	}
}

type fullDisk struct{}

func (fullDisk) Write([]byte) (int, error) { return 0, errors.New("no space left on device") }

// Writing the download failed, not the network: the exit code says which to fix.
func TestAFailedDownloadWriteIsALocalError(t *testing.T) {
	_, err := saveBody(fullDisk{}, strings.NewReader("synthetic"))
	var failed *exitError
	if !errors.As(err, &failed) || failed.exit != ExitLocal {
		t.Fatalf("got %#v", err)
	}
}

type brokenBody struct{}

func (brokenBody) Read([]byte) (int, error) { return 0, errors.New("connection reset") }

func TestABrokenDownloadStaysANetworkError(t *testing.T) {
	_, err := saveBody(io.Discard, brokenBody{})
	var failed *exitError
	if !errors.As(err, &failed) || failed.exit != ExitNetwork {
		t.Fatalf("got %#v", err)
	}
}

// A 303 and a readable current project do not prove the project is the one asked for.
func TestProjectSwitchComparesTheReadBack(t *testing.T) {
	h := newHarness(t, fakeLogin(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/select-project" {
			w.WriteHeader(http.StatusSeeOther)
			return
		}
		jsonAnswer(w, http.StatusOK, `{"company_id":"ACME","project_id":"P2","scope":"ACME/P2"}`)
	}))
	h.signIn()
	got := h.run("", "project", "switch", "ACME/P1", "--json")
	body := decode(t, got.stdout)
	failure, _ := body["error"].(map[string]any)
	if got.code != ExitFailed || failure["code"] != "project_not_switched" || !strings.Contains(failure["detail"].(string), "ACME/P2") {
		t.Fatalf("%+v", got)
	}
}

// Without --project a refusal that is neither "choose one" nor MFA is still a failure.
func TestSessionReportsAScopeFailure(t *testing.T) {
	for status, exit := range map[int]int{http.StatusInternalServerError: ExitServer, http.StatusForbidden: ExitForbidden} {
		h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/system/auth/me" {
				jsonAnswer(w, http.StatusOK, `{"username":"ana","full_name":"Ana","role":"admin","active":1}`)
				return
			}
			jsonAnswer(w, status, `{"detail":"Proyecto fuera de alcance"}`)
		})
		if err := saveSession(h.session, &session{URL: h.api.URL, Cookies: map[string]string{"sipges_session": "s"}}); err != nil {
			t.Fatal(err)
		}
		if got := h.run("", "session", "--json"); got.code != exit {
			t.Fatalf("status %d: %+v", status, got)
		}
	}
}

// The two answers session already explains stay as they were.
func TestSessionStillReportsAnMFARequirement(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/system/auth/me" {
			jsonAnswer(w, http.StatusOK, `{"username":"ana","full_name":"Ana","role":"admin","active":1}`)
			return
		}
		jsonAnswer(w, http.StatusForbidden, `{"detail":"Debe activar MFA"}`)
	})
	if err := saveSession(h.session, &session{URL: h.api.URL, Cookies: map[string]string{"sipges_session": "s"}}); err != nil {
		t.Fatal(err)
	}
	got := h.run("", "session", "--json")
	data, _ := decode(t, got.stdout)["data"].(map[string]any)
	if got.code != ExitOK || data["mfa_required"] != true {
		t.Fatalf("%+v", got)
	}
}

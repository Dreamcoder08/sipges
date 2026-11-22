package cli

import (
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// syntheticTemporary is what a scripted API hands over; never a real password.
const syntheticTemporary = "ACDEFGHJKMNPQRSTUVWX"

func TestResetPasswordPrintsTheTemporaryPasswordOnceWithItsInstruction(t *testing.T) {
	var method, path, origin, cookie string
	h := newHarness(t, fakeLogin(func(w http.ResponseWriter, r *http.Request) {
		method, path, origin = r.Method, r.URL.EscapedPath(), r.Header.Get("Origin")
		if c, err := r.Cookie("sipges_session"); err == nil {
			cookie = c.Value
		}
		w.Header().Set("Cache-Control", "no-store")
		jsonAnswer(w, http.StatusOK, `{"temporary_password":"`+syntheticTemporary+`"}`)
	}))
	h.signIn()
	got := h.run("", "users", "reset-password", "luis.gomez")
	if got.code != ExitOK || got.stderr != "" {
		t.Fatalf("%+v", got)
	}
	if method != http.MethodPost || path != "/system/auth/accounts/luis.gomez/password" || origin != h.api.URL || cookie != syntheticCookie {
		t.Fatalf("sent %s %s origin=%q cookie=%q", method, path, origin, cookie)
	}
	if strings.Count(got.stdout, syntheticTemporary) != 1 {
		t.Fatalf("the temporary password must appear exactly once:\n%s", got.stdout)
	}
	if !strings.Contains(got.stdout, resetPasswordInstruction) {
		t.Fatalf("no instruction:\n%s", got.stdout)
	}

	got = h.run("", "users", "reset-password", "luis.gomez", "--json")
	body := decode(t, got.stdout)
	data, _ := body["data"].(map[string]any)
	if got.code != ExitOK || body["ok"] != true || data["temporary_password"] != syntheticTemporary ||
		data["username"] != "luis.gomez" || data["instruction"] != resetPasswordInstruction {
		t.Fatalf("%+v", got)
	}
}

func TestResetPasswordNeedsOneUsernameAndReportsRefusals(t *testing.T) {
	answers := map[string]struct {
		status int
		body   string
	}{
		"ana":    {http.StatusUnprocessableEntity, `{"detail":"No puede restablecer su propia contraseña aquí; cámbiela con POST /system/auth/password"}`},
		"nobody": {http.StatusNotFound, `{"detail":"Usuario inexistente"}`},
		"luis":   {http.StatusForbidden, `{"detail":"Administración de cuentas restringida"}`},
	}
	sent := 0
	h := newHarness(t, fakeLogin(func(w http.ResponseWriter, r *http.Request) {
		sent++
		user := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/system/auth/accounts/"), "/password")
		jsonAnswer(w, answers[user].status, answers[user].body)
	}))
	h.signIn()
	for _, args := range [][]string{{}, {"a", "b"}, {"luis", "--body", "-"}} {
		if got := h.run("", append([]string{"users", "reset-password"}, args...)...); got.code != ExitUsage {
			t.Errorf("%q: %+v", args, got)
		}
	}
	if sent != 0 {
		t.Fatal("a usage error reached the API")
	}
	for user, want := range map[string]int{"ana": ExitRejected, "nobody": ExitNotFound, "luis": ExitForbidden} {
		got := h.run("", "users", "reset-password", user)
		if got.code != want || !strings.Contains(got.stderr, strings.Split(answers[user].body, `"`)[3]) || got.stdout != "" {
			t.Errorf("%s: %+v", user, got)
		}
	}
}

// The read-only sweep of verify posts to every write route but viewerWrites and wants 403: the
// reset must stay in that sweep.
func TestTheReadOnlySweepCoversThePasswordReset(t *testing.T) {
	routes, err := Routes()
	if err != nil {
		t.Fatal(err)
	}
	route, found := findRoute(routes, http.MethodPost, "/system/auth/accounts/x/password")
	if !found || route.Path != "/system/auth/accounts/{username}/password" || route.Access != AccessSession ||
		route.Command != "users reset-password" {
		t.Fatalf("route = %+v, found %v", route, found)
	}
	if slices.Contains(viewerWrites, route.Path) {
		t.Fatal("the read-only role must not be allowed to reset passwords")
	}
}

func TestResetPasswordKeepsTheTemporaryPasswordWhenTheSessionCannotBeSaved(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes into a read-only folder")
	}
	var h *harness
	h = newHarness(t, fakeLogin(func(w http.ResponseWriter, _ *http.Request) {
		// The session folder turns read-only before the answer arrives.
		if err := os.Chmod(filepath.Dir(h.session), 0o500); err != nil {
			t.Error(err)
		}
		jsonAnswer(w, http.StatusOK, `{"temporary_password":"`+syntheticTemporary+`"}`)
	}))
	h.signIn()
	t.Cleanup(func() { _ = os.Chmod(filepath.Dir(h.session), 0o700) })

	got := h.run("", "users", "reset-password", "luis.gomez")
	if got.code != ExitLocal || strings.Count(got.stdout, syntheticTemporary) != 1 ||
		!strings.Contains(got.stderr, "the password was reset, but the session could not be saved") {
		t.Fatalf("%+v", got)
	}

	_ = os.Chmod(filepath.Dir(h.session), 0o700)
	got = h.run("", "users", "reset-password", "luis.gomez", "--json")
	body := decode(t, got.stdout)
	data, _ := body["data"].(map[string]any)
	warning, _ := data["warning"].(string)
	if got.code != ExitLocal || body["ok"] != true || got.stderr != "" || data["temporary_password"] != syntheticTemporary ||
		!strings.HasPrefix(warning, "the password was reset, but the session could not be saved") {
		t.Fatalf("%+v", got)
	}
}

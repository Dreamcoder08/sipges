package app_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
)

// Ported from apps/api/test/desktop/desktop-update.test.ts and desktop-update-boundaries.test.ts.
// The channel folder is a synthetic one per test; versions are synthetic.

const desktopUpdatePath = "/system/desktop/update"

var desktopScope = map[string]string{"multi": "SIPGES/PRJ-SECHURA", "solo": "SIPGES/PRJ-SECHURA", "reader": "ACME/NORTE", "coord": "ACME/NORTE"}

// desktopChannel writes status.json as the launcher does; available is nil for "nothing newer".
func desktopChannel(t *testing.T, available map[string]any) string {
	t.Helper()
	status, err := json.Marshal(map[string]any{"format": 1, "installed": "1.0.0", "available": available, "checkedAt": "2026-11-11T00:00:00Z"})
	if err != nil {
		t.Fatal(err)
	}
	return desktopChannelText(t, string(status))
}

func desktopChannelText(t *testing.T, status string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "status.json"), []byte(status), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

// startDesktop starts the API with SIPGES_DESKTOP_UPDATE_DIR set to dir, or unset for "".
func startDesktop(t *testing.T, dir string) *server {
	t.Helper()
	if dir == "" {
		if old, ok := os.LookupEnv("SIPGES_DESKTOP_UPDATE_DIR"); ok {
			t.Cleanup(func() { _ = os.Setenv("SIPGES_DESKTOP_UPDATE_DIR", old) })
			_ = os.Unsetenv("SIPGES_DESKTOP_UPDATE_DIR")
		}
	} else {
		t.Setenv("SIPGES_DESKTOP_UPDATE_DIR", dir)
	}
	return start(t, false)
}

func desktopCall(t *testing.T, s *server, method, path, user string) reply {
	t.Helper()
	headers := map[string]string{"x-sipges-scope": "SIPGES/PRJ-SECHURA"}
	if scope, ok := desktopScope[user]; ok {
		headers["x-sipges-scope"] = scope
	}
	return s.do(t, req{method: method, path: path, user: user, headers: headers, sameOrigin: true})
}

func requested(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		if e.Name() != "status.json" {
			names = append(names, e.Name())
		}
	}
	return names
}

const desktopNotes = "Corrige el filtro de registros.\nNuevo resumen semanal."

func TestDesktopUpdateReportsWhatTheLauncherVerified(t *testing.T) {
	s := startDesktop(t, desktopChannel(t, map[string]any{"version": "1.1.0", "notes": desktopNotes}))
	expect(t, desktopCall(t, s, "GET", desktopUpdatePath, "multi"), http.StatusOK,
		`{"installed":"1.0.0","available":"1.1.0","notes":"Corrige el filtro de registros.\nNuevo resumen semanal.","dismissed":false}`)
}

func TestDesktopUpdateWithNothingNewer(t *testing.T) {
	dir := desktopChannel(t, nil)
	s := startDesktop(t, dir)
	expect(t, desktopCall(t, s, "GET", desktopUpdatePath, "multi"), http.StatusOK,
		`{"installed":"1.0.0","available":null,"notes":null,"dismissed":false}`)
	expect(t, desktopCall(t, s, "POST", desktopUpdatePath, "multi"), http.StatusConflict,
		`{"detail":"No hay una actualización disponible"}`)
	if got := requested(t, dir); len(got) != 0 {
		t.Fatalf("requested %v", got)
	}
}

func TestDesktopUpdateDismissLastsUntilTheNextStart(t *testing.T) {
	dir := desktopChannel(t, map[string]any{"version": "1.1.0", "notes": nil})
	s := startDesktop(t, dir)
	expect(t, desktopCall(t, s, "POST", desktopUpdatePath+"/dismiss", "multi"), http.StatusNoContent, "")
	expect(t, desktopCall(t, s, "GET", desktopUpdatePath, "multi"), http.StatusOK,
		`{"installed":"1.0.0","available":"1.1.0","notes":null,"dismissed":true}`)
	if got := requested(t, dir); len(got) != 0 {
		t.Fatalf("requested %v", got)
	}
	next := startDesktop(t, dir)
	expect(t, desktopCall(t, next, "GET", desktopUpdatePath, "multi"), http.StatusOK,
		`{"installed":"1.0.0","available":"1.1.0","notes":null,"dismissed":false}`)
}

func TestDesktopUpdateRequestsTheVerifiedVersionOnly(t *testing.T) {
	dir := desktopChannel(t, map[string]any{"version": "1.1.0", "notes": nil})
	s := startDesktop(t, dir)
	got := s.do(t, req{method: "POST", path: desktopUpdatePath, user: "multi", sameOrigin: true,
		headers: map[string]string{"x-sipges-scope": "SIPGES/PRJ-SECHURA", "Content-Type": "application/json"},
		body:    `{"version":"9.9.9","release":"/tmp/evil"}`})
	expect(t, got, http.StatusAccepted, `{"status":"restarting","version":"1.1.0"}`)
	if names := requested(t, dir); !slices.Equal(names, []string{"request.json"}) {
		t.Fatalf("requested %v", names)
	}
	body, err := os.ReadFile(filepath.Join(dir, "request.json"))
	if err != nil {
		t.Fatal(err)
	}
	var request map[string]any
	if err := json.Unmarshal(body, &request); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(request))
	for k := range request {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	if request["version"] != "1.1.0" || request["format"] != 1.0 || !slices.Equal(keys, []string{"format", "requestedAt", "version"}) {
		t.Fatalf("request %s", body)
	}
}

func TestDesktopUpdateRoutesExistOnlyWithTheChannel(t *testing.T) {
	s := startDesktop(t, "")
	for _, route := range [][2]string{{"GET", desktopUpdatePath}, {"POST", desktopUpdatePath}, {"POST", desktopUpdatePath + "/dismiss"}} {
		expect(t, desktopCall(t, s, route[0], route[1], "multi"), http.StatusNotFound, `{"detail":"Not Found"}`)
		anonymous := s.do(t, req{method: route[0], path: route[1], sameOrigin: true})
		if anonymous.status != http.StatusUnauthorized && anonymous.status != http.StatusNotFound {
			t.Fatalf("%v anonymous: %d", route, anonymous.status)
		}
	}
}

func TestDesktopUpdateRefusesEveryRoleButAdmin(t *testing.T) {
	dir := desktopChannel(t, map[string]any{"version": "1.1.0", "notes": nil})
	s := startDesktop(t, dir)
	for _, user := range []string{"solo", "coord", "reader"} {
		for _, route := range [][2]string{{"GET", desktopUpdatePath}, {"POST", desktopUpdatePath}, {"POST", desktopUpdatePath + "/dismiss"}} {
			got := desktopCall(t, s, route[0], route[1], user)
			if got.status != http.StatusForbidden {
				t.Fatalf("%s %v: %d %s", user, route, got.status, got.body)
			}
			var body struct{ Detail string }
			_ = json.Unmarshal([]byte(got.body), &body)
			if route[0] == "GET" || user == "solo" {
				if body.Detail != "Requiere rol administrador" {
					t.Fatalf("%s %v: %s", user, route, got.body)
				}
			} else if !strings.HasPrefix(body.Detail, "Rol de consulta") && !strings.HasPrefix(body.Detail, "Operación restringida") {
				t.Fatalf("%s %v: %s", user, route, got.body)
			}
		}
	}
	if got := requested(t, dir); len(got) != 0 {
		t.Fatalf("requested %v", got)
	}
	expect(t, desktopCall(t, s, "GET", desktopUpdatePath, "multi"), http.StatusOK,
		`{"installed":"1.0.0","available":"1.1.0","notes":null,"dismissed":false}`)
}

func TestDesktopUpdateAsksForASessionAndASameSiteOrigin(t *testing.T) {
	dir := desktopChannel(t, map[string]any{"version": "1.1.0", "notes": nil})
	s := startDesktop(t, dir)
	for _, method := range []string{"GET", "POST"} {
		expect(t, s.do(t, req{method: method, path: desktopUpdatePath, sameOrigin: true,
			headers: map[string]string{"x-sipges-scope": "SIPGES/PRJ-SECHURA"}}),
			http.StatusUnauthorized, `{"detail":"Inicie sesión para acceder a SIPGES"}`)
	}
	expect(t, s.do(t, req{method: "POST", path: desktopUpdatePath + "/dismiss", sameOrigin: true,
		headers: map[string]string{"x-sipges-scope": "SIPGES/PRJ-SECHURA"}}),
		http.StatusUnauthorized, `{"detail":"Inicie sesión para acceder a SIPGES"}`)
	for _, origin := range []string{"https://evil.example", "", "null"} {
		for _, path := range []string{desktopUpdatePath, desktopUpdatePath + "/dismiss"} {
			got := s.do(t, req{method: "POST", path: path, user: "multi",
				headers: map[string]string{"x-sipges-scope": "SIPGES/PRJ-SECHURA", "Origin": origin}})
			if got.status != http.StatusForbidden {
				t.Fatalf("origin=%q %s: %d %s", origin, path, got.status, got.body)
			}
		}
	}
	if got := requested(t, dir); len(got) != 0 {
		t.Fatalf("requested %v", got)
	}
	expect(t, desktopCall(t, s, "GET", desktopUpdatePath, "multi"), http.StatusOK,
		`{"installed":"1.0.0","available":"1.1.0","notes":null,"dismissed":false}`)
}

func TestDesktopUpdateOffersNothingForAMissingOrMalformedStatus(t *testing.T) {
	for _, status := range []string{
		`{"format":2,"installed":"1.0.0","available":{"version":"1.1.0","notes":null}}`,
		`{"format":1,"installed":"1.0.0","available":{"version":"","notes":null}}`,
		`{"format":1,"installed":"1.0.0","available":"1.1.0"}`,
		`[{"format":1,"installed":"1.0.0","available":{"version":"1.1.0","notes":null}}]`,
		`null`, ``, `{"format":1,"installed":`,
	} {
		dir := desktopChannelText(t, status)
		s := startDesktop(t, dir)
		expect(t, desktopCall(t, s, "GET", desktopUpdatePath, "multi"), http.StatusOK,
			`{"installed":null,"available":null,"notes":null,"dismissed":false}`)
		expect(t, desktopCall(t, s, "POST", desktopUpdatePath, "multi"), http.StatusConflict,
			`{"detail":"No hay una actualización disponible"}`)
		if got := requested(t, dir); len(got) != 0 {
			t.Fatalf("requested %v for %s", got, status)
		}
	}
	dir := t.TempDir()
	s := startDesktop(t, dir)
	expect(t, desktopCall(t, s, "GET", desktopUpdatePath, "multi"), http.StatusOK,
		`{"installed":null,"available":null,"notes":null,"dismissed":false}`)
}

func TestDesktopUpdateRelativeFolderStopsTheStart(t *testing.T) {
	t.Setenv("SIPGES_DESKTOP_UPDATE_DIR", "relative/dir")
	_, err := newHandlerForConfig(t)
	if err == nil || !strings.Contains(err.Error(), "SIPGES_DESKTOP_UPDATE_DIR must be an absolute path") {
		t.Fatalf("err=%v", err)
	}
}

// newHandlerForConfig composes the API without a database: a pool dials on first use.
func newHandlerForConfig(t *testing.T) (http.Handler, error) {
	t.Helper()
	pool, err := pgxpool.New(t.Context(), "postgres://synthetic@127.0.0.1:1/synthetic")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return app.NewHandler(pool, app.Options{})
}

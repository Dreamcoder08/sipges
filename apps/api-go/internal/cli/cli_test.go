package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

type run struct {
	code           int
	stdout, stderr string
}

// harness runs the CLI against a scripted API, with its own session file.
type harness struct {
	t       *testing.T
	api     *httptest.Server
	env     map[string]string
	session string
}

func newHarness(t *testing.T, handler http.HandlerFunc) *harness {
	t.Helper()
	h := &harness{t: t, api: httptest.NewServer(handler), session: filepath.Join(t.TempDir(), "session.json")}
	t.Cleanup(h.api.Close)
	h.env = map[string]string{"SIPGES_URL": h.api.URL, "SIPGES_SESSION_FILE": h.session}
	return h
}

func (h *harness) run(stdin string, args ...string) run {
	h.t.Helper()
	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), args, IO{
		Stdin: strings.NewReader(stdin), Stdout: &stdout, Stderr: &stderr,
		Env: func(name string) string { return h.env[name] },
	})
	return run{code, stdout.String(), stderr.String()}
}

func jsonAnswer(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func decode(t *testing.T, stdout string) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal([]byte(stdout), &body); err != nil {
		t.Fatalf("stdout is not one JSON object: %v\n%s", err, stdout)
	}
	return body
}

func TestEveryStatusHasItsExitCode(t *testing.T) {
	cases := map[int]int{
		200: ExitOK, 303: ExitOK, 400: ExitRejected, 401: ExitAuth, 403: ExitForbidden, 404: ExitNotFound,
		409: ExitRejected, 413: ExitRejected, 415: ExitRejected, 422: ExitRejected, 429: ExitRejected,
		500: ExitServer, 502: ExitServer,
	}
	for status, want := range cases {
		h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
			jsonAnswer(w, status, `{"detail":"synthetic"}`)
		})
		got := h.run("", "call", "GET", "/health", "--json")
		if got.code != want {
			t.Errorf("status %d: exit %d, want %d", status, got.code, want)
		}
		body := decode(t, got.stdout)
		if body["schema"] != Schema || body["status"] != float64(status) || body["ok"] != (want == ExitOK) {
			t.Errorf("status %d: envelope %v", status, body)
		}
	}
}

func TestAnUnreachableAPIIsItsOwnExitCode(t *testing.T) {
	h := newHarness(t, nil)
	h.env["SIPGES_URL"] = "http://127.0.0.1:1"
	got := h.run("", "call", "GET", "/health", "--json")
	if got.code != ExitNetwork || decode(t, got.stdout)["ok"] != false {
		t.Fatalf("%+v", got)
	}
}

func TestSecretsInAnswersAreRedactedOnEveryPath(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		jsonAnswer(w, http.StatusOK, `{"ok":true,"id":"k1","token":"mscli_synthetic","nested":[{"secret":"s3cret","name":"visible"}]}`)
	})
	for _, args := range [][]string{
		{"call", "POST", "/system/integrations/api-keys"},
		{"call", "POST", "/system/integrations/api-keys", "--json"},
	} {
		got := h.run("", args...)
		if strings.Contains(got.stdout, "mscli_synthetic") || strings.Contains(got.stdout, "s3cret") {
			t.Fatalf("%v printed a secret: %s", args, got.stdout)
		}
		if !strings.Contains(got.stdout, "visible") || !strings.Contains(got.stdout, redacted) {
			t.Fatalf("%v: %s", args, got.stdout)
		}
	}
}

func TestProjectFlagIsSentAsTheScopeHeader(t *testing.T) {
	var scope string
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		scope = r.Header.Get("X-SIPGES-Scope")
		jsonAnswer(w, http.StatusOK, `[]`)
	})
	if got := h.run("", "records", "list", "--module", "compromisos", "--project", "ACME/P1"); got.code != ExitOK {
		t.Fatalf("%+v", got)
	}
	if scope != "ACME/P1" {
		t.Fatalf("scope %q", scope)
	}
}

func TestTheComposeProjectNameIsNotATenant(t *testing.T) {
	var scope string
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		scope = r.Header.Get("X-SIPGES-Scope")
		jsonAnswer(w, http.StatusOK, `[]`)
	})
	h.env["SIPGES_PROJECT"] = "sipges-drill" // deploy/local/sipges names its Compose project with this
	h.run("", "records", "list", "--module", "compromisos")
	if scope != "" {
		t.Fatalf("the Compose project became a tenant: %q", scope)
	}
	h.env["SIPGES_SCOPE"] = "ACME/P1"
	h.run("", "records", "list", "--module", "compromisos")
	if scope != "ACME/P1" {
		t.Fatalf("SIPGES_SCOPE was ignored: %q", scope)
	}
}

func TestCallOnlyReachesTheInventory(t *testing.T) {
	asked := 0
	h := newHarness(t, func(http.ResponseWriter, *http.Request) { asked++ })
	got := h.run("", "call", "GET", "/system/not-a-route", "--json")
	if got.code != ExitUsage || asked != 0 {
		t.Fatalf("%+v asked=%d", got, asked)
	}
}

func TestCallPrefersALiteralRouteAndReportsIt(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) { jsonAnswer(w, http.StatusOK, `{}`) })
	got := h.run("", "call", "get", "/api/dashboard", "--json")
	if route := decode(t, got.stdout)["route"]; route != "GET /api/dashboard" {
		t.Fatalf("route %v", route)
	}
	got = h.run("", "call", "GET", "/api/compromisos/C-1", "--json")
	if route := decode(t, got.stdout)["route"]; route != "GET /api/{module}/{id}" {
		t.Fatalf("route %v", route)
	}
}

func TestPathValuesStayOneSegment(t *testing.T) {
	var path string
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.EscapedPath()
		jsonAnswer(w, http.StatusOK, `{}`)
	})
	got := h.run("", "records", "get", "--module", "compromisos", "--id", "../../system/export")
	if got.code != ExitOK || path != "/api/compromisos/..%2F..%2Fsystem%2Fexport" {
		t.Fatalf("%+v path=%q", got, path)
	}
	if got := h.run("", "records", "get", "--module", "compromisos"); got.code != ExitUsage {
		t.Fatalf("a missing path value: %+v", got)
	}
}

func TestBodyComesFromStdinOrAFile(t *testing.T) {
	var seen, contentType string
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		seen, contentType = string(body), r.Header.Get("Content-Type")
		jsonAnswer(w, http.StatusOK, `{"ok":true}`)
	})
	got := h.run(`{"payload":{"Texto":"synthetic"}}`, "records", "create", "--module", "compromisos", "--body", "-")
	if got.code != ExitOK || seen != `{"payload":{"Texto":"synthetic"}}` || contentType != "application/json" {
		t.Fatalf("%+v %q %q", got, seen, contentType)
	}
	file := filepath.Join(t.TempDir(), "body.json")
	if err := os.WriteFile(file, []byte(`{"a":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := h.run("", "call", "POST", "/api/compromisos", "--body", file); got.code != ExitOK || seen != `{"a":1}` {
		t.Fatalf("%+v %q", got, seen)
	}
}

func TestAttachSendsMultipart(t *testing.T) {
	var name, field string
	var content []byte
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		file, header, err := r.FormFile("file")
		if err != nil {
			t.Error(err)
			return
		}
		name, field = header.Filename, r.FormValue("linked_module")
		content, _ = io.ReadAll(file)
		jsonAnswer(w, http.StatusOK, `{"ok":true}`)
	})
	path := filepath.Join(t.TempDir(), "evidence.txt")
	if err := os.WriteFile(path, []byte("synthetic evidence\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := h.run("", "call", "POST", "/system/uploads", "--attach", "file="+path, "--field", "linked_module=compromisos")
	if got.code != ExitOK || name != "evidence.txt" || field != "compromisos" || string(content) != "synthetic evidence\n" {
		t.Fatalf("%+v %q %q %q", got, name, field, content)
	}
	if got := h.run("{}", "call", "POST", "/system/uploads", "--attach", "file="+path, "--body", "-"); got.code != ExitUsage {
		t.Fatalf("%+v", got)
	}
}

func TestFilesGoToDiskAndNeverToTheTerminal(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = io.WriteString(w, "synthetic bytes")
	})
	got := h.run("", "evidence", "download", "--id", "A1", "--json")
	if strings.Contains(got.stdout, "synthetic bytes") {
		t.Fatalf("bytes on stdout: %s", got.stdout)
	}
	file, _ := decode(t, got.stdout)["file"].(map[string]any)
	if file["bytes"] != float64(15) || len(file["sha256"].(string)) != 64 {
		t.Fatalf("%+v", file)
	}
	path := filepath.Join(t.TempDir(), "out.bin")
	if got := h.run("", "evidence", "download", "--id", "A1", "--output", path); got.code != ExitOK {
		t.Fatalf("%+v", got)
	}
	if content, _ := os.ReadFile(path); string(content) != "synthetic bytes" {
		t.Fatalf("file holds %q", content)
	}
	if got := h.run("", "evidence", "download", "--id", "A1", "--output", path); got.code != ExitLocal {
		t.Fatalf("an existing file was not refused: %+v", got)
	}
}

func TestAnErrorAnswerNeverWritesTheOutputFile(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusGone)
		_, _ = io.WriteString(w, "gone")
	})
	path := filepath.Join(t.TempDir(), "out.bin")
	if got := h.run("", "evidence", "download", "--id", "A1", "--output", path); got.code != ExitRejected {
		t.Fatalf("%+v", got)
	}
	if _, err := os.Stat(path); err == nil {
		t.Fatal("an error answer became the output file")
	}
}

func TestAnEventStreamIsReportedNotRead(t *testing.T) {
	release := make(chan struct{})
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	defer close(release)
	got := h.run("", "call", "GET", "/system/events", "--json")
	file, _ := decode(t, got.stdout)["file"].(map[string]any)
	if got.code != ExitOK || file["stream"] != true {
		t.Fatalf("%+v", got)
	}
}

func TestHelpListsEveryTypedCommand(t *testing.T) {
	h := newHarness(t, nil)
	got := h.run("", "help")
	routes, _ := Routes()
	for _, route := range routes {
		if route.Command != "" && !strings.Contains(got.stdout, route.Command) {
			t.Errorf("help does not name %q", route.Command)
		}
	}
}

func TestEvidenceUploadNamesItsFields(t *testing.T) {
	var module, record, kind, filename string
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		_, header, err := r.FormFile("file")
		if err != nil {
			t.Error(err)
			return
		}
		filename, module = header.Filename, r.FormValue("linked_module")
		record, kind = r.FormValue("linked_record_id"), r.FormValue("document_type")
		jsonAnswer(w, http.StatusOK, `{"ok":true}`)
	})
	path := filepath.Join(t.TempDir(), "acta.txt")
	if err := os.WriteFile(path, []byte("synthetic"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := h.run("", "evidence", "upload", "--file", path, "--module", "compromisos", "--record", "C-1", "--document-type", "Acta")
	if got.code != ExitOK || filename != "acta.txt" || module != "compromisos" || record != "C-1" || kind != "Acta" {
		t.Fatalf("%+v", got)
	}
	if got := h.run("", "evidence", "upload", "--file", path); got.code != ExitUsage {
		t.Fatalf("%+v", got)
	}
}

func TestOutputKeepsAJSONAnswerToo(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) { jsonAnswer(w, http.StatusOK, `{"tenant":"synthetic"}`) })
	path := filepath.Join(t.TempDir(), "export.json")
	got := h.run("", "reports", "export", "--output", path, "--json")
	file, _ := decode(t, got.stdout)["file"].(map[string]any)
	if got.code != ExitOK || file["path"] != path {
		t.Fatalf("%+v", got)
	}
	if content, _ := os.ReadFile(path); string(content) != `{"tenant":"synthetic"}` {
		t.Fatalf("file holds %q", content)
	}
}

func TestOutputThatCannotBeWrittenIsAFailure(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	got := h.run("", "reports", "export", "--output", filepath.Join(t.TempDir(), "x"), "--json")
	if got.code == ExitOK {
		t.Fatalf("--output was ignored with success: %+v", got)
	}
}

func TestOptionsThatWouldBeIgnoredAreRefused(t *testing.T) {
	asked := 0
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		asked++
		jsonAnswer(w, http.StatusOK, `{}`)
	})
	for _, args := range [][]string{
		{"call", "GET", "/health", "--param", "nope=1"},
		{"call", "GET", "/health", "--form"},
		{"call", "DELETE", "/api/compromisos/C-1", "--param", "id=C-2"},
		{"records", "delete", "--module", "compromisos", "--id", "A", "--param", "id=B"},
		{"records", "list", "--module", "compromisos", "--param", "nope=1"},
		{"routes", "extra"},
		{"routes", "--project", "ACME/P1"},
		{"routes", "--url", "https://sipges.example.test"},
	} {
		if got := h.run("", append(args, "--json")...); got.code != ExitUsage {
			t.Errorf("%v: %+v", args, got)
		}
	}
	if asked != 0 {
		t.Fatalf("%d refused commands reached the API", asked)
	}
}

func TestEveryPathPrintsOneJSONObject(t *testing.T) {
	h := newHarness(t, nil)
	for _, args := range [][]string{
		{"help", "--json"},
		{"call", "--bogus", "--json=true"},
		{"--json"},
	} {
		got := h.run("", args...)
		if body := decode(t, got.stdout); body["schema"] != Schema {
			t.Errorf("%v: %+v", args, got)
		}
	}
}

func TestHarmlessFieldsAreNotRedacted(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		jsonAnswer(w, http.StatusOK, `{"key":"cluster-1","uri":"/x","session":"s1","otpauth_uri":"otpauth://synthetic"}`)
	})
	got := h.run("", "call", "GET", "/health", "--json")
	data, _ := decode(t, got.stdout)["data"].(map[string]any)
	if data["key"] != "cluster-1" || data["uri"] != "/x" || data["session"] != "s1" {
		t.Fatalf("%v", data)
	}
	if data["otpauth_uri"] != redacted {
		t.Fatalf("otpauth_uri holds the TOTP secret: %v", data)
	}
}

func TestMachineRoutesCarryTheirCredentialAndNoOtherDoes(t *testing.T) {
	var auth, cookie string
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		auth, cookie = r.Header.Get("Authorization"), r.Header.Get("Cookie")
		jsonAnswer(w, http.StatusOK, `{"ok":true}`)
	})
	if err := saveSession(h.session, &session{URL: h.api.URL, Cookies: map[string]string{"sipges_session": "synthetic"}}); err != nil {
		t.Fatal(err)
	}
	h.env["SIPGES_MACHINE_TOKEN"] = "mscli_synthetic"
	if got := h.run("", "call", "POST", "/hooks/ingest/compromisos", "--project", "ACME/P1"); got.code != ExitUsage {
		t.Fatalf("a key's project cannot be chosen: %+v", got)
	}
	got := h.run("", "call", "POST", "/mcp", "--json")
	if got.code != ExitOK || auth != "Bearer mscli_synthetic" || cookie != "" {
		t.Fatalf("%+v auth=%q cookie=%q", got, auth, cookie)
	}
	if strings.Contains(got.stdout+got.stderr, "mscli_synthetic") {
		t.Fatal("the credential reached the output")
	}
	h.run("", "call", "GET", "/api/compromisos")
	if auth != "" {
		t.Fatalf("a session route carried the machine credential: %q", auth)
	}
	delete(h.env, "SIPGES_MACHINE_TOKEN")
	if got := h.run("", "call", "POST", "/mcp"); got.code != ExitUsage {
		t.Fatalf("a machine route without its credential: %+v", got)
	}
}

func TestAddressesThatHideSomethingAreRefused(t *testing.T) {
	h := newHarness(t, nil)
	for _, address := range []string{
		"http://127.0.0.1:18090?x=1", "http://127.0.0.1:18090#f", "http://user:synthetic@127.0.0.1:18090",
	} {
		got := h.run("", "call", "GET", "/health", "--url", address)
		if got.code != ExitUsage || strings.Contains(got.stderr, "synthetic") {
			t.Errorf("%s: %+v", address, got)
		}
	}
}

func TestASessionFileWithoutCookiesStillWorks(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "sipges_scope", Value: "ACME/P1", Path: "/"})
		jsonAnswer(w, http.StatusOK, `{}`)
	})
	body := `{"schema":"` + sessionSchema + `","url":"` + h.api.URL + `"}`
	if err := os.WriteFile(h.session, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := h.run("", "call", "GET", "/health"); got.code != ExitOK {
		t.Fatalf("%+v", got)
	}
}

func TestUsageErrorsAreJSONWhenAskedFor(t *testing.T) {
	h := newHarness(t, nil)
	got := h.run("", "no-such-command", "--json")
	body := decode(t, got.stdout)
	if got.code != ExitUsage || body["ok"] != false || body["schema"] != Schema {
		t.Fatalf("%+v", got)
	}
}

func TestInventoryIsWellFormed(t *testing.T) {
	routes, err := Routes()
	if err != nil {
		t.Fatal(err)
	}
	a := &app{routes: routes}
	builtins := a.builtins()
	keys := map[string]bool{}
	commands := map[string]string{}
	for _, route := range routes {
		if keys[route.Key()] {
			t.Errorf("twice: %s", route.Key())
		}
		keys[route.Key()] = true
		if !slices.Contains([]string{AccessPublic, AccessSession, AccessMachine}, route.Access) {
			t.Errorf("%s: access %q", route.Key(), route.Access)
		}
		if route.Command == "" {
			continue
		}
		if _, builtin := builtins[route.Command]; builtin {
			continue
		}
		if other, taken := commands[route.Command]; taken {
			t.Errorf("command %q is both %s and %s", route.Command, other, route.Key())
		}
		commands[route.Command] = route.Key()
		if name, run, _ := a.resolve(strings.Fields(route.Command)); run == nil || name != route.Command {
			t.Errorf("command %q does not resolve", route.Command)
		}
	}
}

// TestSpeaksOnlyHTTP holds the rule that keeps auth and row-level security in the path: this
// package imports the standard library alone, so it has no driver and no internal package.
func TestSpeaksOnlyHTTP(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), name, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, spec := range parsed.Imports {
			path, _ := strconv.Unquote(spec.Path.Value)
			if strings.Contains(strings.SplitN(path, "/", 2)[0], ".") {
				t.Errorf("%s imports %s: the CLI may only use the standard library", name, path)
			}
		}
	}
}

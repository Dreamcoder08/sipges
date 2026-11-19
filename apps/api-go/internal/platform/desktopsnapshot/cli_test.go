package desktopsnapshot

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Synthetic values only; none of them may reach an output or a snapshot file.
const fakePassword = "clave-sintetica-admin-001"

type fakeRecord map[string]any

type fakeScope struct {
	records map[string][]fakeRecord
	uploads map[string]string
	audit   []map[string]any
}

type fakeOptions struct {
	notManaged, leak, noExport bool
}

func fakeData() map[string]*fakeScope {
	return map[string]*fakeScope{
		"EMPRESA-SINTETICA/PRJ-ALFA": {
			records: map[string][]fakeRecord{
				"eventos": {
					{"_id": "EV-ALFA-1", "Titulo": "VALOR-SECRETO-ALFA", "Asistentes": 12.0, "Hecho": nil},
					{"_id": "EV/ALFA 2", "Titulo": "VALOR-SECRETO-DOS ñ😀", "10": "CLAVE-NUMERICA", "2": true},
				},
				"actores": {{"_id": "A-ALFA-1", "Nombre": "ACTOR-SECRETO"}},
			},
			uploads: map[string]string{"up-alfa-1": "CONTENIDO-SECRETO-ALFA\n"},
			audit: []map[string]any{
				{"id": 1.0, "module": "Eventos", "action": "create", "detail": "DETALLE-SECRETO-1"},
				{"id": 10.0, "module": "Eventos", "action": "update", "detail": "DETALLE-SECRETO-10"},
				{"id": 2.0, "module": "Actores", "action": "create", "detail": "DETALLE-SECRETO-2"},
			},
		},
		"EMPRESA-SINTETICA/PRJ-BETA": {
			records: map[string][]fakeRecord{"eventos": {{"_id": "EV-ALFA-1", "Titulo": "COMUN-SECRETO-BETA"}}},
			uploads: map[string]string{},
		},
	}
}

func secretsOf(data map[string]*fakeScope) []string {
	out := []string{fakePassword, "PRJ-ALFA", "PRJ-BETA", "EMPRESA-SINTETICA", "persona-sintetica"}
	for _, s := range data {
		for _, rows := range s.records {
			for _, r := range rows {
				for k, v := range r {
					out = append(out, fmt.Sprint(v))
					if k != "10" && k != "2" {
						out = append(out, k)
					}
				}
			}
		}
		for id, body := range s.uploads {
			out = append(out, id, strings.TrimSpace(body))
		}
	}
	return out
}

// fakeAPI serves the routes the snapshot reads, like migration.test.mjs's fakeApi.
func fakeAPI(t *testing.T, data map[string]*fakeScope, o fakeOptions) string {
	t.Helper()
	var mu sync.Mutex
	sessions := map[string]bool{}
	answer := func(w http.ResponseWriter, status int, body any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/login" {
			_ = r.ParseForm()
			if r.Form.Get("username") != "admin" || r.Form.Get("password") != fakePassword {
				answer(w, 401, map[string]any{"detail": "no"})
				return
			}
			mu.Lock()
			token := strconv.Itoa(len(sessions) + 1000)
			sessions[token] = true
			mu.Unlock()
			w.Header().Set("Set-Cookie", "sipges_session="+token+"; HttpOnly; Path=/")
			answer(w, 200, map[string]any{"ok": true})
			return
		}
		cookie, err := r.Cookie("sipges_session")
		mu.Lock()
		ok := err == nil && sessions[cookie.Value]
		mu.Unlock()
		if !ok {
			answer(w, 401, map[string]any{"detail": "Unauthorized"})
			return
		}
		if r.URL.Path == "/system/auth/scopes" {
			var list []map[string]any
			for _, name := range []string{"EMPRESA-SINTETICA/PRJ-ALFA", "EMPRESA-SINTETICA/PRJ-BETA"} {
				company, project, _ := strings.Cut(name, "/")
				list = append(list, map[string]any{"company_id": company, "project_id": project})
			}
			answer(w, 200, list)
			return
		}
		scope := data[r.Header.Get("X-SIPGES-Scope")]
		if scope == nil {
			answer(w, 403, map[string]any{"detail": "Seleccione un proyecto"})
			return
		}
		path := r.URL.Path
		switch {
		case path == DesktopUpdatePath && !o.notManaged:
			answer(w, 200, map[string]any{"installed": "1.0.0-sintetico.1", "available": nil})
		case path == "/system/auth/accounts":
			answer(w, 200, []map[string]any{{"username": "admin", "full_name": "persona-sintetica", "active": 1}})
		case strings.HasPrefix(path, "/api/"):
			parts := strings.SplitN(strings.TrimPrefix(r.URL.EscapedPath(), "/api/"), "/", 2)
			slug := parts[0]
			if slug != "eventos" && slug != "actores" {
				answer(w, 404, map[string]any{"detail": "Módulo no válido"})
				return
			}
			if len(parts) == 2 {
				id, _ := urlUnescape(parts[1])
				pool := scope.records[slug]
				if o.leak {
					pool = nil
					for _, s := range data {
						pool = append(pool, s.records[slug]...)
					}
				}
				for _, row := range pool {
					if row["_id"] == id {
						answer(w, 200, row)
						return
					}
				}
				answer(w, 404, map[string]any{"detail": "no"})
				return
			}
			offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
			var rows []map[string]any
			for i, row := range scope.records[slug] {
				if i < offset {
					continue
				}
				copied := map[string]any{"_updated_at": "2026-01-03T00:00:00Z"}
				for k, v := range row {
					copied[k] = v
				}
				rows = append(rows, copied)
			}
			if rows == nil {
				rows = []map[string]any{}
			}
			answer(w, 200, rows)
		case path == "/system/links":
			id := r.URL.Query().Get("id")
			links := []any{}
			if id == "A-ALFA-1" {
				links = append(links, map[string]any{"edge": map[string]any{"id": 41, "note": "NOTA-SECRETA", "source": []string{"actores", "A-ALFA-1"}}})
			}
			answer(w, 200, map[string]any{"links": links})
		case path == "/system/uploads":
			list := []map[string]any{}
			for id, body := range scope.uploads {
				list = append(list, map[string]any{"id": id, "size_bytes": len(body)})
			}
			answer(w, 200, list)
		case strings.HasPrefix(path, "/system/uploads/"):
			rest := strings.TrimPrefix(path, "/system/uploads/")
			id, download := strings.CutSuffix(rest, "/download")
			pool := scope.uploads
			if o.leak && download {
				pool = map[string]string{}
				for _, s := range data {
					for k, v := range s.uploads {
						pool[k] = v
					}
				}
			}
			body, found := pool[id]
			switch {
			case !found:
				answer(w, 404, map[string]any{"detail": "no"})
			case download:
				w.Header().Set("Content-Type", "text/plain")
				_, _ = w.Write([]byte(body))
			default:
				answer(w, 200, map[string]any{"id": id, "size_bytes": len(body), "download_url": "/x"})
			}
		case path == "/system/export" && o.noExport:
			answer(w, 403, map[string]any{"detail": "no"})
		case path == "/system/export":
			stored := []map[string]any{}
			for slug, rows := range scope.records {
				for _, row := range rows {
					stored = append(stored, map[string]any{"module": slug, "id": row["_id"]})
				}
			}
			attachments := []map[string]any{}
			for id, body := range scope.uploads {
				attachments = append(attachments, map[string]any{"id": id, "size_bytes": len(body)})
			}
			audit := scope.audit
			if audit == nil {
				audit = []map[string]any{}
			}
			answer(w, 200, map[string]any{"data": map[string]any{"module_records": stored, "audit": audit, "attachments": attachments, "document_review": []any{}}})
		case path == "/system/audit":
			audit := scope.audit
			if audit == nil {
				audit = []map[string]any{}
			}
			answer(w, 200, audit)
		default:
			answer(w, 404, map[string]any{"detail": "Not Found"})
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func urlUnescape(s string) (string, error) {
	var b bytes.Buffer
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			n, err := strconv.ParseUint(s[i+1:i+3], 16, 8)
			if err != nil {
				return "", err
			}
			b.WriteByte(byte(n))
			i += 2
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String(), nil
}

type ran struct {
	code           int
	stdout, stderr string
}

func testEnv() (Env, *bytes.Buffer, *bytes.Buffer) {
	var out, errOut bytes.Buffer
	return Env{
		Lookup: func(k string) (string, bool) {
			return map[string]string{"SIPGES_MIGRATION_PASSWORD": fakePassword}[k], k == "SIPGES_MIGRATION_PASSWORD"
		},
		Terminal: &Terminal{In: strings.NewReader(""), Out: &bytes.Buffer{}},
		Stdout:   &out, Stderr: &errOut,
	}, &out, &errOut
}

func runMode(run func([]string, Env) int, args ...string) ran {
	env, out, errOut := testEnv()
	code := run(args, env)
	return ran{code, out.String(), errOut.String()}
}

func checkAbsent(t *testing.T, data map[string]*fakeScope, label string, texts ...string) {
	t.Helper()
	all := strings.Join(texts, "\n")
	for _, secret := range secretsOf(data) {
		// Short values (12, true) are found inside hex hashes by chance.
		if len(secret) > 5 && strings.Contains(all, secret) {
			t.Errorf("%s holds the synthetic value %q", label, secret)
		}
	}
}

func TestSnapshotThenCompareFindsNoDifference(t *testing.T) {
	data := fakeData()
	url := fakeAPI(t, data, fakeOptions{})
	dir := t.TempDir()
	before := filepath.Join(dir, "before.json")
	taken := runMode(RunSnapshot, "--url", url, "--out", before)
	if taken.code != 0 {
		t.Fatalf("snapshot: %d %s", taken.code, taken.stderr)
	}
	for _, want := range []string{
		`(?m)^SIPGES snapshot at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$`,
		`(?m)^Projects: 2$`,
		`(?m)^project 1 \[[0-9a-f]{8}\]: records 3 \(actores 1, eventos 2\), links 1, uploads 1, audit 3$`,
		`(?m)^project 2 \[[0-9a-f]{8}\]: records 1 \(eventos 1\), links 0, uploads 0, audit 0$`,
		`(?m)^Accounts: 1$`,
		`(?m)^Written: .*before\.json$`,
	} {
		if !regexp.MustCompile(want).MatchString(taken.stdout) {
			t.Errorf("snapshot output lacks %s:\n%s", want, taken.stdout)
		}
	}
	file, err := os.ReadFile(before)
	if err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(before); filepath.Separator == '/' && info.Mode().Perm()&0o077 != 0 {
		t.Errorf("the snapshot is readable by others: %v", info.Mode())
	}
	checkAbsent(t, data, "the snapshot", string(file), taken.stdout, taken.stderr)
	if again := runMode(RunSnapshot, "--url", url, "--out", before); again.code != 1 || !strings.HasPrefix(again.stderr, "Error: ") {
		t.Fatalf("an existing --out was not refused: %+v", again)
	}

	after := filepath.Join(dir, "after.json")
	compared := runMode(RunCompare, "--before", before, "--url", url, "--out", after)
	if compared.code != 0 || !strings.HasSuffix(compared.stdout, "RESULT: no difference\n") {
		t.Fatalf("compare: %d\n%s%s", compared.code, compared.stdout, compared.stderr)
	}
	for _, want := range []string{
		"Sign-in: ok (password)", "Managed install: version 1.0.0-sintetico.1",
		"  eventos: 2 -> 2, every field identical", "  links: 1 -> 1, identical",
		"  export attachments: 1 -> 1, identical", "  audit: 3 -> 3, 3 kept unchanged",
		"  uploads: 0 -> 0, none", "Accounts: 1 -> 1, identical",
		"Isolation: 5 probes, no record or upload of one project visible in another",
	} {
		if !strings.Contains(compared.stdout, want+"\n") {
			t.Errorf("compare output lacks %q:\n%s", want, compared.stdout)
		}
	}
	checkAbsent(t, data, "the comparison", compared.stdout, compared.stderr)
	written, err := os.ReadFile(after)
	if err != nil {
		t.Fatal(err)
	}
	stamp := regexp.MustCompile(`"takenAt": "[^"]+"`)
	if !bytes.Equal(stamp.ReplaceAll(written, nil), stamp.ReplaceAll(file, nil)) {
		t.Fatal("with the same salt and data, the after file differs from the before file")
	}
}

func TestComparePlantedDifferencesAndLeaks(t *testing.T) {
	dir := t.TempDir()
	before := filepath.Join(dir, "before.json")
	if r := runMode(RunSnapshot, "--url", fakeAPI(t, fakeData(), fakeOptions{}), "--out", before); r.code != 0 {
		t.Fatal(r.stderr)
	}
	changed := fakeData()
	changed["EMPRESA-SINTETICA/PRJ-ALFA"].records["eventos"][0]["Asistentes"] = "12"
	changed["EMPRESA-SINTETICA/PRJ-ALFA"].audit = changed["EMPRESA-SINTETICA/PRJ-ALFA"].audit[:2]
	r := runMode(RunCompare, "--before", before, "--url", fakeAPI(t, changed, fakeOptions{}))
	if r.code != 1 {
		t.Fatalf("a changed field type: %d\n%s", r.code, r.stdout)
	}
	if !regexp.MustCompile(`(?m)^  eventos: 2 -> 2, record \[[0-9a-f]{8}\] field \[[0-9a-f]{8}\] differs$`).MatchString(r.stdout) ||
		!strings.Contains(r.stdout, "  audit: 3 -> 2, 2 kept unchanged, 1 missing\n") ||
		!strings.HasSuffix(r.stdout, "RESULT: 2 differences\n") {
		t.Fatalf("the differences were not reported:\n%s", r.stdout)
	}
	checkAbsent(t, changed, "the comparison", r.stdout, r.stderr)

	leaked := runMode(RunCompare, "--before", before, "--url", fakeAPI(t, fakeData(), fakeOptions{leak: true}))
	if leaked.code != 1 || !regexp.MustCompile(`(?m)^Isolation: 5 probes, [1-9]\d* visible in another project \(records \d+, uploads 1\)$`).MatchString(leaked.stdout) ||
		!strings.HasSuffix(leaked.stdout, "RESULT: 1 difference\n") {
		t.Fatalf("a leak was not reported: %d\n%s", leaked.code, leaked.stdout)
	}

	gap := runMode(RunCompare, "--before", before, "--url", fakeAPI(t, fakeData(), fakeOptions{noExport: true}))
	if gap.code != 1 || !strings.Contains(gap.stdout, "  export: readable on one side only\n") {
		t.Fatalf("an export on one side only: %d\n%s", gap.code, gap.stdout)
	}
}

func TestCompareRefusesAnotherServerOrNoServer(t *testing.T) {
	dir := t.TempDir()
	before := filepath.Join(dir, "before.json")
	if r := runMode(RunSnapshot, "--url", fakeAPI(t, fakeData(), fakeOptions{}), "--out", before); r.code != 0 {
		t.Fatal(r.stderr)
	}
	other := runMode(RunCompare, "--before", before, "--url", fakeAPI(t, fakeData(), fakeOptions{notManaged: true}), "--out", filepath.Join(dir, "x.json"))
	if other.code != NotComparedExit || !strings.HasSuffix(other.stdout, "Managed install: no (GET /system/desktop/update answered 404); the server on this port is not the new version installed with install.ps1 -Release\nRESULT: not compared (not the managed install)\n") {
		t.Fatalf("another server: %d\n%s", other.code, other.stdout)
	}
	if _, err := os.Stat(filepath.Join(dir, "x.json")); err == nil {
		t.Fatal("--out was written for a comparison that did not run")
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	gone := "http://" + l.Addr().String()
	_ = l.Close()
	none := runMode(RunCompare, "--before", before, "--url", gone)
	if none.code != NotComparedExit || none.stdout != "RESULT: not compared (the server could not be reached or the connection dropped: fetch failed, ECONNREFUSED)\n" || none.stderr != "Error: fetch failed\n" {
		t.Fatalf("no server: %+v", none)
	}
	wrong := runMode(RunCompare, "--before", before, "--url", fakeAPI(t, fakeData(), fakeOptions{}), "--password-file", filepath.Join(dir, "missing"))
	if wrong.code != 1 || strings.Contains(wrong.stdout, "RESULT") {
		t.Fatalf("a missing --password-file: %+v", wrong)
	}
	if err := os.WriteFile(filepath.Join(dir, "bad"), []byte("wrong\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	refused := runMode(RunCompare, "--before", before, "--url", fakeAPI(t, fakeData(), fakeOptions{}), "--password-file", filepath.Join(dir, "bad"))
	if refused.code != 1 || refused.stdout != "Sign-in failed (status 401)\nRESULT: sign-in failed\n" {
		t.Fatalf("a refused sign-in: %+v", refused)
	}
}

// With Node on PATH, snapshot.mjs and compare.mjs run against the same fake: either one's
// snapshot compares with the other's comparison, with the same lines.
func TestCrossWithNodeScripts(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH; migration.test.mjs and the Windows go-mode drill cross-check")
	}
	scripts := filepath.Join("..", "..", "..", "..", "..", "deploy", "desktop", "migration")
	url := fakeAPI(t, fakeData(), fakeOptions{})
	dir := t.TempDir()
	runNode := func(script string, args ...string) ran {
		cmd := exec.Command(node, append([]string{filepath.Join(scripts, script)}, args...)...)
		cmd.Env = append(os.Environ(), "SIPGES_MIGRATION_PASSWORD="+fakePassword)
		cmd.Stdin = strings.NewReader("")
		var out, errOut bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &errOut
		err := cmd.Run()
		code := 0
		if exit, ok := err.(*exec.ExitError); ok { //nolint:errorlint // the process's own exit
			code = exit.ExitCode()
		} else if err != nil {
			t.Fatal(err)
		}
		return ran{code, out.String(), errOut.String()}
	}
	nodeFile := filepath.Join(dir, "node.json")
	if r := runNode("snapshot.mjs", "--url", url, "--out", nodeFile, "--otp", ""); r.code != 0 {
		t.Fatalf("snapshot.mjs: %+v", r)
	}
	goFile := filepath.Join(dir, "go.json")
	if r := runMode(RunSnapshot, "--url", url, "--out", goFile, "--otp", ""); r.code != 0 {
		t.Fatalf("--snapshot: %+v", r)
	}
	for _, before := range []string{nodeFile, goFile} {
		n := runNode("compare.mjs", "--before", before, "--url", url, "--otp", "", "--out", before+".node")
		g := runMode(RunCompare, "--before", before, "--url", url, "--otp", "", "--out", before+".go")
		if n.code != 0 || g.code != 0 || n.stdout != g.stdout || n.stderr != g.stderr {
			t.Fatalf("%s compared differently:\nnode %d\n%s%s\ngo %d\n%s%s", filepath.Base(before), n.code, n.stdout, n.stderr, g.code, g.stdout, g.stderr)
		}
		a, _ := os.ReadFile(before + ".node")
		b, _ := os.ReadFile(before + ".go")
		stamp := regexp.MustCompile(`"takenAt": "[^"]+"`)
		if !bytes.Equal(stamp.ReplaceAll(a, nil), stamp.ReplaceAll(b, nil)) {
			t.Fatalf("%s: the after files differ:\n%s\n%s", filepath.Base(before), a, b)
		}
	}
}

func TestCredentialsFollowClientMjs(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "password")
	if err := os.WriteFile(file, []byte("\xEF\xBB\xBF  clave-sintetica \r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	none := func(string) (string, bool) { return "", false }
	piped := &Terminal{In: strings.NewReader("no-se-lee\n"), Out: &bytes.Buffer{}, IsTerminal: func() bool { return false }}
	l, err := credentials(map[string]string{"--url": "u", "--password-file": file}, none, piped)
	if err != nil || l.Password != "clave-sintetica" || l.OTP != "" || l.Username != "admin" {
		t.Fatalf("%+v %v", l, err)
	}
	// Without a terminal nothing is asked: an empty password and code.
	if l, err = credentials(map[string]string{"--url": "u"}, none, piped); err != nil || l.Password != "" || l.OTP != "" {
		t.Fatalf("%+v %v", l, err)
	}
	var shown bytes.Buffer
	restored := false
	typing := &Terminal{
		In: strings.NewReader("clave-tecleada\n 123456 \n"), Out: &shown, IsTerminal: func() bool { return true },
		HideTyping: func() (func(), error) { return func() { restored = true }, nil },
	}
	if l, err = credentials(map[string]string{"--url": "u", "--user": "otra"}, none, typing); err != nil || l.Password != "clave-tecleada" || l.OTP != "123456" || l.Username != "otra" {
		t.Fatalf("%+v %v", l, err)
	}
	if !restored || shown.String() != "Contraseña: \nCódigo MFA (vacío si no tiene): " {
		t.Fatalf("prompts %q, restored %v", shown.String(), restored)
	}
	signals := make(chan os.Signal, 1)
	blocked := &Terminal{
		In: blockingReader{}, Out: &bytes.Buffer{}, IsTerminal: func() bool { return true },
		HideTyping:  func() (func(), error) { restored = false; return func() { restored = true }, nil },
		Interrupted: func() (<-chan os.Signal, func()) { return signals, func() {} },
	}
	signals <- os.Interrupt
	if _, err := blocked.readHidden("Contraseña: "); err == nil || err.Error() != "Cancelado (Ctrl+C)" || !restored {
		t.Fatalf("Ctrl+C: %v, restored %v", err, restored)
	}
	if _, err := parseArgs([]string{"--url", "a", "--url", "b"}, []string{"--url"}); err == nil || err.Error() != "Invalid option --url; use --help" {
		t.Fatalf("a repeated option: %v", err)
	}
}

type blockingReader struct{}

func (blockingReader) Read([]byte) (int, error) { time.Sleep(time.Hour); return 0, nil }

func TestTOTPMatchesRFC6238(t *testing.T) {
	// RFC 6238's SHA-1 vector: the secret "12345678901234567890" at 59 s is 94287082 (8 digits).
	code, err := TOTP("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59/30)
	if err != nil || code != "287082" {
		t.Fatalf("%s %v", code, err)
	}
	if _, err := TOTP("not base32!", 1); err == nil {
		t.Fatal("a secret that is not base32 was accepted")
	}
}

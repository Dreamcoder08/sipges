package main

// Ported from deploy/desktop/updater/launcher.test.mjs, verifier-launcher.test.mjs,
// first-start.test.mjs and run-current.test.mjs: the same rules, on the Go launcher.

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktoprelease"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktopupdate"
)

func strp(s string) *string { return &s }

// rule 1: offers the newest correctly signed release and its notes, installing nothing.
func TestOffersTheNewestSignedReleaseAndItsNotesInstallingNothing(t *testing.T) {
	f := newFixture(t)
	f.release("1.1.0", releaseOptions{notes: strp("Mejoras menores.")})
	f.release("1.2.0", releaseOptions{notes: strp("Nueva pantalla de informes.")})
	r := startLauncher(t, f, nil)
	check := r.waitEvent("update_check", 1)
	if check["installed"] != "1.0.0" || check["available"] != "1.2.0" {
		t.Fatalf("update_check %v", check)
	}
	status := f.statusJSON()
	if status["format"] != float64(1) || status["installed"] != "1.0.0" {
		t.Fatalf("status %v", status)
	}
	available, _ := status["available"].(map[string]any)
	if available["version"] != "1.2.0" || available["notes"] != "Nueva pantalla de informes." {
		t.Fatalf("available %v", status["available"])
	}
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", status["checkedAt"].(string)); err != nil {
		t.Fatalf("checkedAt %v", status["checkedAt"])
	}
	if f.current() != "1.0.0" {
		t.Fatal("the check installed something")
	}
	if got := r.serve.versions(); !slices.Equal(got, []string{"1.0.0"}) {
		t.Fatalf("started %v", got)
	}
	if res := r.stop(); res.code != 0 || res.err != nil {
		t.Fatalf("stop: %+v", res)
	}
}

// A release without notes is offered with notes null, as JSON.stringify writes it.
func TestAReleaseWithoutNotesIsOfferedWithNullNotes(t *testing.T) {
	f := newFixture(t)
	f.release("1.1.0", releaseOptions{})
	r := startLauncher(t, f, nil)
	r.waitEvent("update_check", 1)
	data, err := os.ReadFile(filepath.Join(f.root, "update-channel", "status.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data, []byte("\"available\": {\n    \"version\": \"1.1.0\",\n    \"notes\": null\n  },")) {
		t.Fatalf("status.json:\n%s", data)
	}
	if !bytes.HasSuffix(data, []byte("}\n")) {
		t.Fatalf("status.json must end with a newline:\n%s", data)
	}
}

// rule 5: tampered, foreign-key, older and equal releases are never offered.
func TestTamperedForeignOlderAndEqualReleasesAreNeverOffered(t *testing.T) {
	f := newFixture(t)
	tampered := f.release("1.3.0", releaseOptions{})
	put(t, filepath.Join(tampered, "package", "start.mjs"), "// changed after signing\n")
	_, foreign, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f.release("1.4.0", releaseOptions{key: foreign})
	f.release("0.9.0", releaseOptions{})
	f.release("1.0.0", releaseOptions{})
	r := startLauncher(t, f, nil)
	check := r.waitEvent("update_check", 1)
	if check["available"] != nil {
		t.Fatalf("offered %v", check["available"])
	}
	reasons := strings.Join(toStrings(check["skipped"]), "|")
	for _, want := range []string{
		"File does not match the signed release: start.mjs",
		"The release signature does not match the trusted update key",
		"Version 0.9.0 is not newer than the installed 1.0.0",
		"Version 1.0.0 is not newer than the installed 1.0.0",
	} {
		if !strings.Contains(reasons, want) {
			t.Fatalf("skipped %q lacks %q", reasons, want)
		}
	}
	if f.statusJSON()["available"] != nil {
		t.Fatal("status offers an update")
	}
}

func toStrings(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

// rule 6: a missing source or a slow check leaves startup ready with one log line.
func TestAMissingSourceOrASlowCheckLeavesStartupReadyWithOneLine(t *testing.T) {
	f := newFixture(t)
	r := startLauncher(t, f, func(c *launchConfig) { c.Source = filepath.Join(f.dir, "missing") })
	failed := r.waitEvent("update_check_failed", 1)
	if failed["reason"] == "" {
		t.Fatalf("no reason: %v", failed)
	}
	r.waitEvent("started", 1)
	r.stop()

	g := newFixture(t)
	slow := startLauncher(t, g, func(c *launchConfig) {
		c.CheckTimeout = 50 * time.Millisecond
		c.Find = func(string, string) (*desktoprelease.Found, error) {
			time.Sleep(time.Second)
			return nil, errors.New("too late")
		}
	})
	failed = slow.waitEvent("update_check_failed", 1)
	if failed["reason"] != "no answer within 50 ms" {
		t.Fatalf("reason %v", failed["reason"])
	}
	slow.waitEvent("started", 1)
	checks := 0
	for _, name := range slow.names() {
		if strings.HasPrefix(name, "update_check") {
			checks++
		}
	}
	if checks != 1 {
		t.Fatalf("events %v", slow.names())
	}
}

// rule 2: without a click nothing is installed, and an earlier click never applies on start.
func TestAnEarlierClickNeverAppliesOnStart(t *testing.T) {
	f := newFixture(t)
	f.release("1.1.0", releaseOptions{})
	f.request("1.1.0")
	r := startLauncher(t, f, nil)
	r.waitEvent("update_check", 1)
	time.Sleep(200 * time.Millisecond)
	if f.current() != "1.0.0" || slices.Contains(r.names(), "update_started") {
		t.Fatalf("updated without a click: %v", r.names())
	}
	if _, err := os.Stat(filepath.Join(f.root, "update-channel", "request.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the earlier request is still there: %v", err)
	}
}

// The click updates through the verified release and restarts the new version on the same port.
func TestTheClickUpdatesThroughTheVerifiedReleaseAndRestartsTheNewVersion(t *testing.T) {
	f := newFixture(t)
	f.release("1.1.0", releaseOptions{notes: strp("Notas.")})
	var migrated, readied []desktopupdate.Target
	r := startLauncher(t, f, func(c *launchConfig) {
		c.Migrate = func(_ context.Context, target desktopupdate.Target) error {
			migrated = append(migrated, target)
			return nil
		}
		c.Ready = func(_ context.Context, target desktopupdate.Target) error {
			readied = append(readied, target)
			return nil
		}
	})
	r.waitEvent("update_check", 1)
	f.request("1.1.0")
	updated := r.waitEvent("updated", 1)
	if updated["from"] != "1.0.0" || updated["to"] != "1.1.0" || !strings.Contains(updated["preUpdateCopy"].(string), ".pre-update-") {
		t.Fatalf("updated %v", updated)
	}
	second := r.waitEvent("started", 2)
	if second["version"] != "1.1.0" || second["port"] != float64(18000) {
		t.Fatalf("started %v", second)
	}
	if f.current() != "1.1.0" {
		t.Fatalf("current %s", f.current())
	}
	if len(migrated) != 1 || len(readied) != 1 || migrated[0].Version != "1.1.0" {
		t.Fatalf("migrate %v ready %v", migrated, readied)
	}
	status := f.statusJSON()
	if status["installed"] != "1.1.0" || status["available"] != nil {
		t.Fatalf("status %v", status)
	}
	wantOrder := []string{"started", "update_check", "update_started", "updated", "started"}
	if got := r.names(); !slices.Equal(got, wantOrder) {
		t.Fatalf("events %v, want %v", got, wantOrder)
	}
	if first := r.events()[0]; first["stateCopies"] == nil {
		t.Fatalf("started without stateCopies: %v", first)
	}
	if copies := r.events()[4]["stateCopies"].(map[string]any); copies["count"] != float64(1) {
		t.Fatalf("stateCopies after the update %v", copies)
	}
}

// A request that names another version than the one verified is ignored.
func TestARequestForAnotherVersionIsIgnored(t *testing.T) {
	f := newFixture(t)
	f.release("1.1.0", releaseOptions{})
	r := startLauncher(t, f, nil)
	r.waitEvent("update_check", 1)
	f.request("9.9.9")
	ignored := r.waitEvent("update_request_ignored", 1)
	if ignored["version"] != "9.9.9" || ignored["verified"] != "1.1.0" {
		t.Fatalf("ignored %v", ignored)
	}
	put(t, filepath.Join(f.root, "update-channel", "request.json"), "not json")
	if ignored = r.waitEvent("update_request_ignored", 2); ignored["version"] != nil {
		t.Fatalf("ignored %v", ignored)
	}
	if f.current() != "1.0.0" {
		t.Fatal("installed")
	}
}

// A failed update rolls back and starts the previous version again.
func TestAFailedUpdateRollsBackAndStartsThePreviousVersionAgain(t *testing.T) {
	f := newFixture(t)
	f.release("1.1.0", releaseOptions{})
	r := startLauncher(t, f, func(c *launchConfig) {
		c.Migrate = func(context.Context, desktopupdate.Target) error { return errors.New("synthetic migration failure") }
	})
	r.waitEvent("update_check", 1)
	f.request("1.1.0")
	failed := r.waitEvent("update_failed", 1)
	if failed["code"] != "ROLLED_BACK" || failed["version"] != "1.1.0" || failed["action"] != nil {
		t.Fatalf("update_failed %v", failed)
	}
	if again := r.waitEvent("started", 2); again["version"] != "1.0.0" {
		t.Fatalf("started %v", again)
	}
	if f.current() != "1.0.0" {
		t.Fatal("not rolled back")
	}
}

// removePreUpdateCopies makes the rollback impossible, as launcher.test.mjs does.
func removePreUpdateCopies(stateDir string) {
	entries, _ := os.ReadDir(filepath.Dir(stateDir))
	for _, e := range entries {
		if strings.Contains(e.Name(), ".pre-update-") {
			_ = os.RemoveAll(filepath.Join(filepath.Dir(stateDir), e.Name()))
		}
	}
}

// After a rollback that did not finish, the launcher exits with code 3, a clear message and no
// server; the next start refuses with one line and the same exit code.
func TestARollbackThatDidNotFinishEndsWithCode3AndNoServer(t *testing.T) {
	f := newFixture(t)
	f.release("1.1.0", releaseOptions{})
	r := startLauncher(t, f, func(c *launchConfig) {
		c.Migrate = func(_ context.Context, target desktopupdate.Target) error {
			put(t, filepath.Join(target.StateDir, "half-migrated"), "synthetic")
			removePreUpdateCopies(target.StateDir)
			return errors.New("synthetic migration failure")
		}
	})
	r.waitEvent("update_check", 1)
	f.request("1.1.0")
	res, ok := r.result(10 * time.Second)
	if !ok || res.code != 3 {
		t.Fatalf("result %+v %v; events %v", res, ok, r.names())
	}
	failed := r.waitEvent("update_failed", 1)
	if failed["code"] != "ROLLBACK_INCOMPLETE" || !strings.Contains(failed["action"].(string), "copia de seguridad") {
		t.Fatalf("update_failed %v", failed)
	}
	if !strings.HasPrefix(r.l.halted(), "SIPGES no se inició: una actualización falló") {
		t.Fatalf("halted %q", r.l.halted())
	}
	if got := r.serve.versions(); len(got) != 1 {
		t.Fatalf("started again on the unrestored state: %v", got)
	}

	var stdout, stderr bytes.Buffer
	code := runLauncherCLI(context.Background(), []string{"--install", f.root, "--port", "18001"}, nil, &stdout, &stderr, nil)
	if code != 3 {
		t.Fatalf("exit %d\n%s", code, stderr.String())
	}
	events := parseEvents(t, stdout.String())
	if len(events) != 1 || events[0]["event"] != "start_refused" || events[0]["code"] != "ROLLBACK_INCOMPLETE" {
		t.Fatalf("events %v", events)
	}
	notice := regexp.MustCompile(`^SIPGES no se inició: una actualización falló y sus datos no se pudieron restaurar\. No borre nada\. Restaure la copia de seguridad .*state\.pre-update-.* o contacte con soporte\.\nDetalle: `)
	if !notice.MatchString(stderr.String()) {
		t.Fatalf("stderr %q", stderr.String())
	}
	if _, err := os.Stat(f.state); err != nil {
		t.Fatalf("state folder: %v", err)
	}
}

// The click re-verifies the release: a folder that no longer holds that version installs nothing.
func TestTheClickReVerifiesTheRelease(t *testing.T) {
	f := newFixture(t)
	release := f.release("1.1.0", releaseOptions{})
	r := startLauncher(t, f, nil)
	r.waitEvent("update_check", 1)
	put(t, filepath.Join(release, "package", "start.mjs"), "// swapped after the check\n")
	f.request("1.1.0")
	refused := r.waitEvent("update_request_refused", 1)
	if refused["version"] != "1.1.0" || !strings.Contains(refused["reason"].(string), "The release folder no longer holds the verified version 1.1.0") {
		t.Fatalf("refused %v", refused)
	}
	if f.current() != "1.0.0" || f.statusJSON()["available"] != nil {
		t.Fatal("installed, or still offered")
	}
	if slices.Contains(r.names(), "update_started") {
		t.Fatalf("events %v", r.names())
	}
	if res, ended := r.result(100 * time.Millisecond); ended {
		t.Fatalf("SIPGES stopped: %+v", res)
	}
}

// Stopping SIPGES during the re-check at the click cancels the update.
func TestStoppingDuringTheReCheckCancelsTheUpdate(t *testing.T) {
	f := newFixture(t)
	f.release("1.1.0", releaseOptions{})
	calls := 0
	release := make(chan struct{})
	entered := make(chan struct{})
	r := startLauncher(t, f, func(c *launchConfig) {
		c.Find = func(root, source string) (*desktoprelease.Found, error) {
			calls++
			if calls == 2 {
				close(entered)
				<-release
			}
			return findUpdate(root, source)
		}
	})
	r.waitEvent("update_check", 1)
	f.request("1.1.0")
	<-entered
	r.cancel()
	close(release)
	res, ok := r.result(10 * time.Second)
	if !ok || res.code != 0 {
		t.Fatalf("result %+v %v", res, ok)
	}
	r.waitEvent("update_cancelled", 1)
	if f.current() != "1.0.0" || slices.Contains(r.names(), "update_started") {
		t.Fatalf("events %v", r.names())
	}
}

// After an update, a version that cannot start ends the launcher instead of leaving it idle.
func TestAVersionThatCannotStartAfterAnUpdateEndsTheLauncher(t *testing.T) {
	f := newFixture(t)
	f.release("1.1.0", releaseOptions{})
	r := startLauncher(t, f, func(c *launchConfig) {
		c.Ready = func(_ context.Context, target desktopupdate.Target) error {
			return os.WriteFile(filepath.Join(target.StateDir, "data-key"), nil, 0o600)
		}
	})
	r.waitEvent("update_check", 1)
	f.request("1.1.0")
	res, ok := r.result(10 * time.Second)
	if !ok || res.code != 1 {
		t.Fatalf("result %+v %v; events %v", res, ok, r.names())
	}
	failed := r.waitEvent("start_failed", 1)
	if failed["version"] != "1.1.0" || !strings.Contains(failed["reason"].(string), "data-key is empty") {
		t.Fatalf("start_failed %v", failed)
	}
}

// After an update, a status file that cannot be written never keeps SIPGES from starting or stopping.
func TestAStatusFileThatCannotBeWrittenNeverBlocks(t *testing.T) {
	f := newFixture(t)
	f.release("1.1.0", releaseOptions{})
	r := startLauncher(t, f, func(c *launchConfig) {
		c.Ready = func(context.Context, desktopupdate.Target) error {
			return os.RemoveAll(filepath.Join(f.root, "update-channel"))
		}
	})
	r.waitEvent("update_check", 1)
	f.request("1.1.0")
	if again := r.waitEvent("started", 2); again["version"] != "1.1.0" {
		t.Fatalf("started %v", again)
	}
	r.waitEvent("status_write_failed", 1)
	if res := r.stop(); res.code != 0 {
		t.Fatalf("stop %+v", res)
	}
}

// A server that ends by itself ends the launcher with its code.
func TestTheLauncherEndsWithItsServer(t *testing.T) {
	f := newFixture(t)
	r := startLauncher(t, f, func(c *launchConfig) { c.Source = "" })
	r.waitEvent("started", 1)
	r.serve.mu.Lock()
	srv := r.serve.running
	r.serve.mu.Unlock()
	srv.end(4)
	res, ok := r.result(5 * time.Second)
	if !ok || res.code != 4 {
		t.Fatalf("result %+v %v", res, ok)
	}
	if slices.ContainsFunc(r.names(), func(n string) bool { return strings.HasPrefix(n, "update_check") }) {
		t.Fatalf("checked without --releases: %v", r.names())
	}
}

// The second stop kills the server at once.
func TestKillEndsTheServerAtOnce(t *testing.T) {
	f := newFixture(t)
	r := startLauncher(t, f, nil)
	r.waitEvent("started", 1)
	r.l.kill()
	r.serve.mu.Lock()
	srv := r.serve.running
	r.serve.mu.Unlock()
	select {
	case <-srv.Exited():
	case <-time.After(time.Second):
		t.Fatal("not killed")
	}
	if srv.Code() != 137 {
		t.Fatalf("code %d", srv.Code())
	}
}

// writeDatabase makes the state folder hold an existing database, with its secrets.
func writeDatabase(t *testing.T, state string, withKey bool) {
	t.Helper()
	put(t, filepath.Join(state, "pg18", "PG_VERSION"), "18\n")
	put(t, filepath.Join(state, "admin-password"), "SyntheticAdmin-2026\n")
	if withKey {
		put(t, filepath.Join(state, "data-key"), "c3ludGhldGljLWRhdGEta2V5LTMyLWJ5dGVzLXh4eHg=\n")
	}
}

// first-start rule a: the launcher runs the first start before it starts any version.
func TestTheLauncherRunsTheFirstStartBeforeAnyVersion(t *testing.T) {
	f := newFixture(t)
	writeDatabase(t, f.state, true)
	var migrated []string
	r := startLauncher(t, f, func(c *launchConfig) {
		c.Source = ""
		c.Migrate = func(_ context.Context, target desktopupdate.Target) error {
			migrated = append(migrated, filepath.Base(target.StateDir))
			return nil
		}
	})
	first := r.waitEvent("first_start", 1)
	if first["version"] != "1.0.0" || !strings.Contains(first["preUpdateCopy"].(string), "state.pre-update-") {
		t.Fatalf("first_start %v", first)
	}
	r.waitEvent("started", 1)
	if got := r.names(); !slices.Equal(got[:2], []string{"first_start", "started"}) {
		t.Fatalf("events %v", got)
	}
	if len(migrated) != 2 || !strings.Contains(migrated[0], ".rehearsal-") || migrated[1] != "state" {
		t.Fatalf("migrated %v", migrated)
	}
}

// T33/T35: stopping during the first start ends its boot and is a normal stop.
func TestStoppingDuringTheFirstStartEndsAsAStop(t *testing.T) {
	f := newFixture(t)
	writeDatabase(t, f.state, true)
	entered := make(chan struct{})
	r := startLauncher(t, f, func(c *launchConfig) {
		c.Migrate = func(ctx context.Context, _ desktopupdate.Target) error {
			close(entered)
			<-ctx.Done()
			return ctx.Err()
		}
	})
	<-entered
	r.cancel()
	res, ok := r.result(10 * time.Second)
	if !ok || res.code != 0 || res.err != nil {
		t.Fatalf("result %+v %v", res, ok)
	}
	r.waitEvent("first_start_cancelled", 1)
	if len(r.serve.versions()) != 0 {
		t.Fatal("a version started")
	}
}

// first-start rule b: a database without its data key is refused, and the launcher never
// creates a new data key over it.
func TestARefusedFirstStartNeverCreatesADataKey(t *testing.T) {
	f := newFixture(t)
	writeDatabase(t, f.state, false)
	var stdout, stderr bytes.Buffer
	code := runLauncherCLI(context.Background(), []string{"--install", f.root, "--port", "18002"}, nil, &stdout, &stderr, nil)
	if code != 1 {
		t.Fatalf("exit %d\n%s", code, stderr.String())
	}
	events := parseEvents(t, stdout.String())
	if len(events) != 1 || events[0]["event"] != "start_refused" ||
		!strings.Contains(events[0]["action"].(string), "Sus datos no se tocaron") {
		t.Fatalf("events %v", events)
	}
	if !strings.HasPrefix(stderr.String(), "SIPGES no se inició: la versión nueva no pudo abrir los datos existentes.") ||
		!strings.Contains(stderr.String(), "\nError: ") {
		t.Fatalf("stderr %q", stderr.String())
	}
	if _, err := os.Stat(filepath.Join(f.state, "data-key")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a data key was created: %v", err)
	}
}

// A fresh state folder gets its secrets once; an existing secret is never rewritten.
func TestPrepareStateCreatesMissingSecretsOnce(t *testing.T) {
	state := filepath.Join(t.TempDir(), "state")
	if err := prepareState(state); err != nil {
		t.Fatal(err)
	}
	key, _ := os.ReadFile(filepath.Join(state, "data-key"))
	pw, _ := os.ReadFile(filepath.Join(state, "admin-password"))
	if len(strings.TrimSpace(string(key))) != 44 || len(strings.TrimSpace(string(pw))) != 24 {
		t.Fatalf("key %q password %q", key, pw)
	}
	put(t, filepath.Join(state, "admin-password"), "  \n")
	if err := prepareState(state); err != nil {
		t.Fatal(err)
	}
	again, _ := os.ReadFile(filepath.Join(state, "data-key"))
	newPw, _ := os.ReadFile(filepath.Join(state, "admin-password"))
	if string(again) != string(key) || strings.TrimSpace(string(newPw)) == "" {
		t.Fatalf("key rewritten or blank password kept: %q %q", again, newPw)
	}
	if info, err := os.Stat(filepath.Join(state, "uploads")); err != nil || !info.IsDir() {
		t.Fatalf("uploads: %v", err)
	}
}

// env: no inherited SIPGES_* reaches the server, in any letter case; the launcher's own values do.
func TestTheServerGetsOnlyTheSIPGESSettingsTheLauncherSets(t *testing.T) {
	base := []string{
		"PATH=/bin", "SIPGES_DATABASE_URL=postgres://elsewhere", "sipges_admin_password=inherited",
		"SIPGES_WEB_DIR=/other/web", "SIPGES_ALLOWED_HOSTS=evil.example", "SIPGES_DESKTOP_UPDATE_DIR=",
		"SIPGES_LOG_LEVEL=debug",
	}
	env, err := launcherEnv(base, [][2]string{
		{"SIPGES_DATABASE_URL", "postgres://local"}, {"SIPGES_ADMIN_PASSWORD", "pw"},
		{"SIPGES_WEB_DIR", "/version/web"}, {"SIPGES_ALLOWED_HOSTS", "localhost,127.0.0.1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"PATH=/bin", "SIPGES_DATABASE_URL=postgres://local", "SIPGES_ADMIN_PASSWORD=pw",
		"SIPGES_WEB_DIR=/version/web", "SIPGES_ALLOWED_HOSTS=localhost,127.0.0.1",
	}
	if !slices.Equal(env, want) {
		t.Fatalf("env %v\nwant %v", env, want)
	}
	if _, err := launcherEnv(nil, [][2]string{{"SIPGES_PGLITE_DIR", "/x"}}); err == nil {
		t.Fatal("a variable outside the allow-list was accepted")
	}
}

// The server environment names the version's own binaries' folders and the update channel only
// for the running server.
func TestServerEnvNamesTheVersionsWebFolderAndTheChannel(t *testing.T) {
	version := t.TempDir()
	mkdir(t, filepath.Join(version, "web"))
	sec := secrets{dataKey: "k", adminPassword: "pw"}
	bins := versionBins{api: "/v/go/api", migrations: "/v/go/migrations", web: filepath.Join(version, "web")}
	env, err := serverEnv([]string{"SIPGES_PGLITE_DIR=/old"}, bins, filepath.Join(version, "state"), sec, "postgres://u", 9000, "/root/update-channel")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"SIPGES_DATABASE_URL=postgres://u", "SIPGES_DATA_KEY=k", "SIPGES_ADMIN_PASSWORD=pw", "SIPGES_HOST=127.0.0.1",
		"SIPGES_PORT=9000", "SIPGES_COOKIE_SECURE=0", "SIPGES_MIGRATIONS_DIR=/v/go/migrations",
		"SIPGES_WEB_DIR=" + filepath.Join(version, "web"), "SIPGES_ALLOWED_HOSTS=localhost,127.0.0.1",
		"SIPGES_DESKTOP_UPDATE_DIR=/root/update-channel",
	} {
		if !slices.Contains(env, want) {
			t.Fatalf("env %v lacks %s", env, want)
		}
	}
	if slices.Contains(env, "SIPGES_PGLITE_DIR=/old") {
		t.Fatal("inherited SIPGES_PGLITE_DIR passed")
	}
	boot, _ := serverEnv(nil, bins, "/state", sec, "postgres://u", 9000, "")
	if slices.ContainsFunc(boot, func(kv string) bool { return strings.HasPrefix(kv, "SIPGES_DESKTOP_UPDATE_DIR=") }) {
		t.Fatalf("the boot got an update channel: %v", boot)
	}
}

// The verifier adapter refuses as the Node updater does, so desktopupdate reports REFUSED.
func TestTheReleaseVerifierRefusesAKeyThatDiffersFromTheInstalledOne(t *testing.T) {
	f := newFixture(t)
	next := f.release("1.1.0", releaseOptions{})
	c, err := desktopupdate.ReadCurrent(f.root)
	if err != nil {
		t.Fatal(err)
	}
	_, err = releaseVerifier{}.Verify(context.Background(), desktopupdate.VerifyRequest{
		ReleaseDir: next, Installed: &desktopupdate.Installed{Version: c.Version, Dir: c.Dir},
		TrustKey: []byte("-----BEGIN PUBLIC KEY-----\nother\n-----END PUBLIC KEY-----\n"),
	})
	if !errors.Is(err, desktopupdate.ErrRefused) ||
		err.Error() != "The installed version already defines the update key; --trust-key is only for an install without one" {
		t.Fatalf("err %v", err)
	}
	rel, err := releaseVerifier{}.Verify(context.Background(), desktopupdate.VerifyRequest{
		ReleaseDir: next, Installed: &desktopupdate.Installed{Version: c.Version, Dir: c.Dir},
	})
	if err != nil || rel.Version != "1.1.0" || rel.PackageDir != filepath.Join(next, "package") || len(rel.Files) == 0 {
		t.Fatalf("release %+v %v", rel, err)
	}
}

// The CLI follows launcher.mjs: --install is required and options are checked.
func TestTheLauncherCLIChecksItsOptions(t *testing.T) {
	for _, args := range [][]string{
		{}, {"--install"}, {"--install", "/r", "--port", "0"}, {"--install", "/r", "--bogus", "x"},
		{"--install", "/r", "extra"},
	} {
		var stdout, stderr bytes.Buffer
		if code := runLauncherCLI(context.Background(), args, nil, &stdout, &stderr, nil); code != 1 || !strings.Contains(stderr.String(), "Error: ") {
			t.Fatalf("%v: exit %d %q", args, code, stderr.String())
		}
	}
	var stdout, stderr bytes.Buffer
	if code := runLauncherCLI(context.Background(), []string{"--help"}, nil, &stdout, &stderr, nil); code != 0 || !strings.Contains(stdout.String(), "--install <root>") {
		t.Fatalf("help: %d %q", code, stdout.String())
	}
}

// The halt notices are the launcher's Spanish sentences.
func TestHaltNoticesAreTheLaunchersOwn(t *testing.T) {
	if got := haltNotice(""); got != "SIPGES no se inició: una actualización falló y sus datos no se pudieron restaurar. No borre nada. Restaure la copia de seguridad previa a la actualización (junto a la carpeta de datos) o contacte con soporte." {
		t.Fatalf("%q", got)
	}
	ri := &desktopupdate.Error{Code: desktopupdate.CodeRollbackIncomplete, Message: "m", PreUpdateCopy: "/s.pre-update-x"}
	if got := firstStartNotice(ri); got != haltNotice("/s.pre-update-x") {
		t.Fatalf("%q", got)
	}
	if got := firstStartNotice(errors.New("x")); got != "SIPGES no se inició: la versión nueva no pudo abrir los datos existentes. Sus datos no se tocaron. No borre nada y contacte con soporte (detalle en launcher.log)." {
		t.Fatalf("%q", got)
	}
}

// A state folder whose data is still PGlite only (the one-time migrator never ran) is refused:
// the Go launcher must never open it as an empty PostgreSQL 18 database.
func TestPGliteDataThatWasNotMovedIsNeverOpenedEmpty(t *testing.T) {
	f := newFixture(t)
	put(t, filepath.Join(f.state, "pglite", "PG_VERSION"), "18\n")
	put(t, filepath.Join(f.state, "data-key"), "c3ludGhldGljLWRhdGEta2V5LTMyLWJ5dGVzLXh4eHg=\n")
	put(t, filepath.Join(f.state, "admin-password"), "SyntheticAdmin-2026\n")
	var stdout, stderr bytes.Buffer
	code := runLauncherCLI(context.Background(), []string{"--install", f.root, "--port", "18003"}, nil, &stdout, &stderr, nil)
	if code != 1 {
		t.Fatalf("exit %d\n%s", code, stderr.String())
	}
	events := parseEvents(t, stdout.String())
	if len(events) != 1 || events[0]["event"] != "start_refused" ||
		events[0]["reason"] != "The state folder holds PGlite data that was not moved to PostgreSQL 18" ||
		!strings.Contains(events[0]["action"].(string), "Sus datos no se tocaron") {
		t.Fatalf("events %v", events)
	}
	if siblings, _ := os.ReadDir(f.dir); slices.ContainsFunc(siblings, func(e os.DirEntry) bool { return strings.HasPrefix(e.Name(), "state.") }) {
		t.Fatalf("a copy of the state folder was made: %v", siblings)
	}
	for _, name := range []string{filepath.Join(f.state, "pg18"), filepath.Join(f.root, "first-start.json")} {
		if _, err := os.Stat(name); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s was written: %v", name, err)
		}
	}
}

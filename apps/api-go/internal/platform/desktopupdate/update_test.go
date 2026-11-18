package desktopupdate

// Port of the transaction cases of deploy/desktop/updater/updater.test.mjs, verifier-state.test.mjs
// and verifier-failed.test.mjs. Migration and readiness are injected; no server is booted.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

const crashHelperEnv = "SIPGES_DESKTOPUPDATE_CRASH_HELPER"

// TestMain doubles as the crash driver: with crashHelperEnv set, the test binary runs one update
// and exits with status 70 at the named step, as a crash would, leaving lock and journal behind.
func TestMain(m *testing.M) {
	if spec := os.Getenv(crashHelperEnv); spec != "" {
		os.Exit(crashDriver(spec))
	}
	os.Exit(m.Run())
}

func crashDriver(spec string) int {
	parts := strings.Split(spec, string(os.PathListSeparator)+"|")
	root, release, crashAt := parts[0], parts[1], parts[2]
	_, err := Update(context.Background(), UpdateOptions{
		Root: root, Release: release, Verifier: &fakeVerifier{},
		Migrate: func(_ context.Context, target Target) error {
			return os.WriteFile(filepath.Join(target.StateDir, "pglite", "migrated"), []byte("synthetic"), 0o600)
		},
		Ready: noop,
		OnStep: func(step string) error {
			if step == crashAt {
				os.Exit(70)
			}
			return nil
		},
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func crashAt(t *testing.T, root, release, step string) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), crashHelperEnv+"="+strings.Join([]string{root, release, step}, string(os.PathListSeparator)+"|"))
	out, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 70 {
		t.Fatalf("crash at %s: %v %s", step, err, out)
	}
}

func TestStepsAreTheNodeSteps(t *testing.T) {
	want := []string{"locked", "verified", "staged", "installed", "state-copied", "rehearsed", "migrated", "switched", "ready", "committed"}
	if !slices.Equal(Steps, want) {
		t.Fatalf("Steps = %v", Steps)
	}
}

func TestRule3CrashAfterAnyStepLeavesACompleteVersionAndRecoveryIsConsistent(t *testing.T) {
	for _, step := range Steps {
		if step == "rehearsed" {
			continue
		}
		t.Run(step, func(t *testing.T) {
			f := newFixture(t, t.TempDir())
			before := snapshot(t, f.state)
			crashAt(t, f.root, f.release("1.1.0"), step)
			switched := slices.Index(Steps, step) >= slices.Index(Steps, "switched")
			crashed, err := InspectInstall(f.root)
			if err != nil || !crashed.Complete {
				t.Fatalf("crashed install: %v %+v", err, crashed)
			}
			if want := map[bool]string{true: "1.1.0", false: "1.0.0"}[switched]; crashed.Version != want {
				t.Fatalf("crashed version %s, want %s", crashed.Version, want)
			}
			recovered, err := Recover(context.Background(), f.root)
			if err != nil {
				t.Fatal(err)
			}
			kept := step == "committed"
			want := map[bool]string{true: "1.1.0", false: "1.0.0"}[kept]
			if recovered.Current.Version != want {
				t.Fatalf("recovered %s, want %s", recovered.Current.Version, want)
			}
			after, err := InspectInstall(f.root)
			if err != nil || !after.Complete || after.Version != want {
				t.Fatalf("after: %v %+v", err, after)
			}
			expected := before
			if kept {
				expected = map[string]string{}
				for k, v := range before {
					expected[k] = v
				}
				expected["pglite/migrated"] = snapshot(t, f.state)["pglite/migrated"]
			}
			assertSnapshot(t, snapshot(t, f.state), expected, step)
			next, err := f.update(f.release("1.2.0"), noop, noop)
			if err != nil || next.To != "1.2.0" {
				t.Fatalf("next update: %v", err)
			}
		})
	}
}

func TestRule3PointerIsReplacedByOneRenameAndNoTemporaryFileRemains(t *testing.T) {
	f := newFixture(t, t.TempDir())
	before, err := os.Stat(filepath.Join(f.root, "current.json"))
	if err != nil {
		t.Fatal(err)
	}
	var seen []os.FileInfo
	_, err = Update(context.Background(), UpdateOptions{
		Root: f.root, Release: f.release("1.1.0"), Verifier: f.verifier, Migrate: noop, Ready: noop,
		OnStep: func(step string) error {
			if step == "migrated" || step == "switched" {
				info, err := os.Stat(filepath.Join(f.root, "current.json"))
				if err != nil {
					return err
				}
				seen = append(seen, info)
			}
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(seen[0], before) || os.SameFile(seen[1], before) {
		t.Fatal("the pointer was not replaced by one rename at the switch")
	}
	if got := strings.Join(names(t, f.root), ","); got != "current.json,install.json,update.log,versions" {
		t.Fatalf("root holds %s", got)
	}
	if got := strings.Join(names(t, filepath.Join(f.root, "versions")), ","); got != "1.0.0,1.1.0" {
		t.Fatalf("versions holds %s", got)
	}
}

func TestRule4StateIsByteIdenticalAfterAnyUpdateExceptForTheDatedCopy(t *testing.T) {
	fixed := func() time.Time { return time.Date(2026, 11, 11, 10, 15, 30, 0, time.UTC) }
	type scenario struct {
		name    string
		migrate Hook
		ready   Hook
		code    Code
		ok      bool
	}
	scenarios := []scenario{
		{"success", func(_ context.Context, target Target) error {
			_, err := os.ReadFile(filepath.Join(target.StateDir, "data-key"))
			return err
		}, noop, "", true},
		{"refused", noop, noop, CodeRefused, false},
		{"migration fails", func(_ context.Context, target Target) error {
			_ = os.WriteFile(filepath.Join(target.StateDir, "pglite/base/1/16384"), []byte("half-migrated"), 0o600)
			_ = os.WriteFile(filepath.Join(target.StateDir, "uploads/new.bin"), []byte("x"), 0o600)
			return errors.New("synthetic migration failure")
		}, noop, CodeRolledBack, false},
		{"readiness fails", func(_ context.Context, target Target) error {
			return os.WriteFile(filepath.Join(target.StateDir, "pglite/PG_VERSION"), []byte("18\n"), 0o600)
		}, func(context.Context, Target) error { return errors.New("synthetic readiness failure") }, CodeRolledBack, false},
	}
	for _, s := range scenarios {
		t.Run(s.name, func(t *testing.T) {
			f := newFixture(t, t.TempDir())
			before := snapshot(t, f.state)
			release := f.release("1.1.0")
			if s.code == CodeRefused {
				put(t, filepath.Join(release, "release.sig"), badSignature+"\n", 0)
			}
			_, err := Update(context.Background(), UpdateOptions{
				Root: f.root, Release: release, Verifier: f.verifier, Migrate: s.migrate, Ready: s.ready, Now: fixed,
			})
			if s.ok && err != nil {
				t.Fatal(err)
			}
			if !s.ok {
				_ = wantCode(t, err, s.code, s.name)
			}
			assertSnapshot(t, snapshot(t, f.state), before, s.name)
			got := siblings(t, f.state)
			if s.code == CodeRefused {
				if len(got) != 0 {
					t.Fatalf("siblings %v", got)
				}
				return
			}
			copyName := "state.pre-update-20261111T101530Z-1.0.0-to-1.1.0"
			if !slices.Contains(got, copyName) {
				t.Fatalf("siblings %v", got)
			}
			assertSnapshot(t, snapshot(t, filepath.Join(filepath.Dir(f.state), copyName)), before, "pre-update copy")
			others := slices.DeleteFunc(slices.Clone(got), func(n string) bool { return n == copyName })
			want := []string{}
			if s.code != "" {
				want = []string{"state.failed-20261111T101530Z-1.1.0"}
			}
			if !slices.Equal(others, want) {
				t.Fatalf("others %v, want %v", others, want)
			}
		})
	}
}

func TestRule5FailedReadinessSwitchesBackAndLogsIt(t *testing.T) {
	f := newFixture(t, t.TempDir())
	var seen []string
	_, err := f.update(f.release("1.1.0"), noop, func(_ context.Context, target Target) error {
		current, err := ReadCurrent(f.root)
		if err != nil {
			return err
		}
		seen = append(seen, fmt.Sprint(target.Version, " ", current.Dir == target.VersionDir))
		return errors.New("synthetic readiness failure")
	})
	e := wantCode(t, err, CodeRolledBack, "ready")
	if e.Message != "Update to 1.1.0 failed at ready and was rolled back to 1.0.0: synthetic readiness failure" {
		t.Fatalf("message %q", e.Message)
	}
	if !slices.Equal(seen, []string{"1.1.0 true"}) {
		t.Fatalf("seen %v", seen)
	}
	current, err := InspectInstall(f.root)
	if err != nil || current.Version != "1.0.0" || !current.Complete {
		t.Fatalf("%v %+v", err, current)
	}
	last := lastLog(t, f.root)
	if last["event"] != "rolled-back" || last["from"] != "1.0.0" || last["to"] != "1.1.0" || last["step"] != "ready" || last["reason"] != "synthetic readiness failure" {
		t.Fatalf("log %v", last)
	}
	if _, ok := last["time"].(string); !ok {
		t.Fatal("log line without time")
	}
}

func TestRule6FailedMigrationRollsBackAndRestoresTheStateFolder(t *testing.T) {
	f := newFixture(t, t.TempDir())
	before := snapshot(t, f.state)
	readied := 0
	_, err := f.update(f.release("1.1.0"), func(_ context.Context, target Target) error {
		if target.StateDir != f.state {
			t.Errorf("migrated %s", target.StateDir)
		}
		_ = os.WriteFile(filepath.Join(target.StateDir, "pglite/base/1/16384"), []byte("half-migrated"), 0o600)
		_ = os.Remove(filepath.Join(target.StateDir, "uploads/synthetic-project/evidence.pdf"))
		return errors.New("synthetic migration failure")
	}, func(context.Context, Target) error { readied++; return nil })
	e := wantCode(t, err, CodeRolledBack, "migrate")
	if e.Message != "Update to 1.1.0 failed at migrate and was rolled back to 1.0.0: synthetic migration failure" {
		t.Fatalf("message %q", e.Message)
	}
	if readied != 0 {
		t.Fatal("ready ran")
	}
	assertSnapshot(t, snapshot(t, f.state), before, "state")
	if c, _ := ReadCurrent(f.root); c.Version != "1.0.0" {
		t.Fatalf("current %s", c.Version)
	}
	if last := lastLog(t, f.root); last["event"] != "rolled-back" || last["step"] != "migrate" {
		t.Fatalf("log %v", last)
	}
	if ExitCode(err) != 2 {
		t.Fatalf("exit code %d", ExitCode(err))
	}
}

func TestRule6StateGivenAsALinkIsRefusedAtInstallBeforeAnythingIsWritten(t *testing.T) {
	dir := t.TempDir()
	makeState(t, filepath.Join(dir, "real"))
	if err := os.Symlink(filepath.Join(dir, "real"), filepath.Join(dir, "state")); err != nil {
		t.Fatal(err)
	}
	release := filepath.Join(dir, "release")
	writeRelease(t, release, "1.0.0")
	_, err := Install(context.Background(), InstallOptions{
		Root: filepath.Join(dir, "install"), Release: release, StateDir: filepath.Join(dir, "state"),
		TrustKey: []byte("k"), Verifier: &fakeVerifier{},
	})
	e := wantCode(t, err, CodeRefused, "linked state")
	if !regexp.MustCompile(`^The state folder .* is a link or junction: pass the real folder of the copy, never a link to it$`).MatchString(e.Message) {
		t.Fatalf("message %q", e.Message)
	}
	if exists(t, filepath.Join(dir, "install")) {
		t.Fatal("the install root was created")
	}
}

func TestRule6StateThatBecameALinkOrHoldsOneIsRefusedBeforeAnyCopy(t *testing.T) {
	shapes := map[string]struct {
		make    func(dir, state string) error
		message string
	}{
		"replaced by a link": {func(dir, state string) error {
			if err := os.Rename(state, filepath.Join(dir, "moved-state")); err != nil {
				return err
			}
			return os.Symlink(filepath.Join(dir, "moved-state"), state)
		}, `^The state folder .* is a link; record the real folder instead$`},
		"link inside": {func(dir, state string) error {
			return os.Symlink(filepath.Join(dir, "outside"), filepath.Join(state, "uploads", "elsewhere"))
		}, `^The state folder holds a link or special file \(uploads/elsewhere\); it cannot be copied safely$`},
		"a link to a file, deep inside pglite": {func(dir, state string) error {
			put(t, filepath.Join(dir, "outside-file"), "x", 0)
			return os.Symlink(filepath.Join(dir, "outside-file"), filepath.Join(state, "pglite/base/1/16385"))
		}, `holds a link or special file \(pglite/base/1/16385\)`},
		"a dangling link": {func(dir, state string) error {
			return os.Symlink(filepath.Join(dir, "missing"), filepath.Join(state, "dangling"))
		}, `holds a link or special file \(dangling\)`},
		"a named pipe": {func(_, state string) error {
			if runtime.GOOS == "windows" {
				return errors.New("no fifo on windows")
			}
			return mkfifo(filepath.Join(state, "pglite", "pipe"))
		}, `holds a link or special file \(pglite/pipe\)`},
	}
	for name, shape := range shapes {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			f := newFixture(t, dir)
			release := f.release("1.1.0")
			if err := shape.make(dir, f.state); err != nil {
				t.Fatal(err)
			}
			before := snapshot(t, dir)
			delete(before, "install/update.log")
			calls := 0
			_, err := f.update(release, func(context.Context, Target) error { calls++; return nil }, noop)
			e := wantCode(t, err, CodeRefused, name)
			if !regexp.MustCompile(shape.message).MatchString(e.Message) {
				t.Fatalf("message %q", e.Message)
			}
			if calls != 0 {
				t.Fatal("migrated")
			}
			after := snapshot(t, dir)
			delete(after, "install/update.log")
			assertSnapshot(t, after, before, name)
			if lastLog(t, f.root)["event"] != "refused" {
				t.Fatal("not logged as refused")
			}
		})
	}
}

func TestRule6StateSwappedForALinkJustBeforeTheCopyRollsBackCleanly(t *testing.T) {
	dir := t.TempDir()
	f := newFixture(t, dir)
	before := snapshot(t, f.state)
	moved := filepath.Join(dir, "moved-state")
	_, err := Update(context.Background(), UpdateOptions{
		Root: f.root, Release: f.release("1.1.0"), Verifier: f.verifier, Migrate: noop, Ready: noop,
		OnStep: func(step string) error {
			if step != "installed" {
				return nil
			}
			if err := os.Rename(f.state, moved); err != nil {
				return err
			}
			return os.Symlink(moved, f.state)
		},
	})
	e := wantCode(t, err, CodeRolledBack, "swapped")
	if !regexp.MustCompile(`failed at state copy .*is a link`).MatchString(e.Message) {
		t.Fatalf("message %q", e.Message)
	}
	if c, _ := ReadCurrent(f.root); c.Version != "1.0.0" {
		t.Fatal("not rolled back")
	}
	assertSnapshot(t, snapshot(t, moved), before, "moved state")
	if exists(t, filepath.Join(f.root, "update-journal.json")) {
		t.Fatal("journal left")
	}
	if got, err := Recover(context.Background(), f.root); err != nil || got.Recovered {
		t.Fatalf("recover: %v %+v", err, got)
	}
}

func TestStateHardLinkedFileIsCopiedAsItsOwnFile(t *testing.T) {
	dir := t.TempDir()
	makeState(t, filepath.Join(dir, "state"))
	if err := os.Link(filepath.Join(dir, "state/pglite/PG_VERSION"), filepath.Join(dir, "peer")); err != nil {
		t.Fatal(err)
	}
	f := newFixtureAt(t, dir, filepath.Join(dir, "state"), false)
	before := snapshot(t, f.state)
	_, err := f.update(f.release("1.1.0"), func(_ context.Context, target Target) error {
		_ = os.WriteFile(filepath.Join(target.StateDir, "pglite/PG_VERSION"), []byte("broken\n"), 0o600)
		return errors.New("synthetic migration failure")
	}, noop)
	_ = wantCode(t, err, CodeRolledBack, "hard link")
	assertSnapshot(t, snapshot(t, f.state), before, "state")
}

func diskOf(avail, block uint64, asked *[]string) func(string) (Disk, error) {
	return func(path string) (Disk, error) {
		if asked != nil {
			*asked = append(*asked, path)
		}
		return Disk{Avail: avail, BlockSize: block}, nil
	}
}

var neededPattern = regexp.MustCompile(`^Not enough free disk beside the state folder for the pre-update copy and one restore: (\d+) bytes needed, (\d+) free$`)

func TestRoomBoundaryIsExactAndUsesBlocksTimesBlockSizeBesideTheState(t *testing.T) {
	f := newFixture(t, t.TempDir())
	next := f.release("1.1.0")
	var asked []string
	run := func(disk func(string) (Disk, error)) (UpdateResult, error) {
		return Update(context.Background(), UpdateOptions{
			Root: f.root, Release: next, Verifier: f.verifier, Migrate: noop, Ready: noop, Statfs: disk,
		})
	}
	_, err := run(diskOf(0, 4096, &asked))
	e := wantCode(t, err, CodeRefused, "no room")
	m := neededPattern.FindStringSubmatch(e.Message)
	// 5 files (8280 bytes) and 11 entries of 4096, twice.
	if m == nil || m[1] != fmt.Sprint(2*(8280+11*4096)) || m[2] != "0" {
		t.Fatalf("message %q", e.Message)
	}
	if !slices.Equal(asked, []string{filepath.Dir(f.state)}) {
		t.Fatalf("asked %v", asked)
	}
	need := uint64(2 * (8280 + 11*4096))
	before := snapshot(t, filepath.Dir(f.state))
	delete(before, "install/update.log")
	for _, d := range []func(string) (Disk, error){diskOf(need-1, 1, nil), diskOf(1, need-1, nil)} {
		_, err := run(d)
		_ = wantCode(t, err, CodeRefused, "one byte short")
	}
	after := snapshot(t, filepath.Dir(f.state))
	delete(after, "install/update.log")
	assertSnapshot(t, after, before, "unchanged")
	done, err := run(diskOf(need/2, 2, nil))
	if err != nil || done.To != "1.1.0" {
		t.Fatalf("exact room: %v", err)
	}
}

func TestRoomRealDiskIsNotRefusedByMistake(t *testing.T) {
	f := newFixture(t, t.TempDir())
	if done, err := f.update(f.release("1.1.0"), noop, noop); err != nil || done.To != "1.1.0" {
		t.Fatal(err)
	}
}

func TestRoomAdoptedInstallNeedsThreeCopiesAndARefusalRecordsNoAdoption(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "state")
	makeState(t, state)
	old := filepath.Join(dir, "old")
	makePackage(t, old, "0.9.0")
	root := filepath.Join(dir, "install")
	release := filepath.Join(dir, "release")
	writeRelease(t, release, "1.0.0")
	_, err := Update(context.Background(), UpdateOptions{
		Root: root, Release: release, Verifier: &fakeVerifier{}, Adopt: &Adoption{Dir: old, StateDir: state},
		TrustKey: []byte("k"), Migrate: noop, Ready: noop, Statfs: diskOf(0, 4096, nil),
	})
	e := wantCode(t, err, CodeRefused, "adopted room")
	if m := neededPattern.FindStringSubmatch(e.Message); m == nil || m[1] != fmt.Sprint(3*(8280+11*4096)) {
		t.Fatalf("message %q", e.Message)
	}
	if got := strings.Join(names(t, root), ","); got != "update.log" {
		t.Fatalf("root holds %s", got)
	}
	if c, err := ReadCurrent(root); err != nil || c != nil {
		t.Fatalf("current %+v %v", c, err)
	}
	if s := siblings(t, state); len(s) != 0 {
		t.Fatalf("siblings %v", s)
	}
}

func TestRule7OldPlainPackageIsAdoptedAndTheFirstUpdateRehearsesOnACopy(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "state")
	makeState(t, state)
	old := filepath.Join(dir, "old")
	makePackage(t, old, "0.9.0")
	before := snapshot(t, state)
	root := filepath.Join(dir, "install")
	release := filepath.Join(dir, "release")
	writeRelease(t, release, "1.0.0")
	fixed := func() time.Time { return time.Date(2026, 11, 11, 10, 15, 30, 0, time.UTC) }
	var calls []string
	verifier := &fakeVerifier{}
	_, err := Update(context.Background(), UpdateOptions{
		Root: root, Release: release, Verifier: verifier, Adopt: &Adoption{Dir: old, StateDir: state},
		TrustKey: []byte("k"), Now: fixed,
		Migrate: func(_ context.Context, target Target) error {
			calls = append(calls, "migrate "+target.StateDir)
			if strings.Contains(target.StateDir, ".rehearsal-") {
				return errors.New("synthetic rehearsal failure")
			}
			return nil
		},
		Ready: noop,
	})
	e := wantCode(t, err, CodeRolledBack, "rehearsal")
	if !strings.HasPrefix(e.Message, "Update to 1.0.0 failed at rehearsal on a copy of the state folder; the state folder was not touched: synthetic rehearsal failure") {
		t.Fatalf("message %q", e.Message)
	}
	if !slices.Equal(calls, []string{"migrate " + state + ".rehearsal-20261111T101530Z-1.0.0"}) {
		t.Fatalf("calls %v", calls)
	}
	assertSnapshot(t, snapshot(t, state), before, "state")
	current, err := ReadCurrent(root)
	if err != nil || current.Version != "0.9.0" || !current.Adopted || current.Dir != old {
		t.Fatalf("adopted pointer %+v %v", current, err)
	}
	if req := verifier.calls[0]; req.Installed == nil || req.Installed.Dir != old || string(req.TrustKey) != "k" {
		t.Fatalf("verifier asked %+v", req)
	}
	calls = nil
	done, err := Update(context.Background(), UpdateOptions{
		Root: root, Release: release, Verifier: verifier, Now: fixed,
		Migrate: func(_ context.Context, target Target) error {
			calls = append(calls, target.StateDir)
			return nil
		},
		Ready: noop,
	})
	if err != nil || done.From != "0.9.0" || done.To != "1.0.0" {
		t.Fatalf("second try: %v %+v", err, done)
	}
	if len(calls) != 2 || !strings.Contains(calls[0], ".rehearsal-") || calls[1] != state {
		t.Fatalf("calls %v", calls)
	}
	if line := lastLog(t, root); line["event"] != "updated" || line["rehearsalCopy"] == nil {
		t.Fatalf("log %v", line)
	}
}

func TestAdvisory5IOErrorWhileStagingIsLoggedAsFailedAndChangesNothing(t *testing.T) {
	if os.Geteuid() == 0 || runtime.GOOS == "windows" {
		t.Skip("permission bits do not stop this user")
	}
	f := newFixture(t, t.TempDir())
	next := f.release("1.1.0")
	if err := os.Chmod(filepath.Join(next, "package/web/index.html"), 0); err != nil {
		t.Fatal(err)
	}
	before := snapshot(t, f.state)
	_, err := f.update(next, noop, noop)
	if !errors.Is(err, os.ErrPermission) {
		t.Fatalf("want a permission error, got %v", err)
	}
	last := lastLog(t, f.root)
	if last["event"] != "failed" || last["step"] != "stage" || last["code"] != "EACCES" {
		t.Fatalf("log %v", last)
	}
	assertSnapshot(t, snapshot(t, f.state), before, "state")
	if got := names(t, filepath.Join(f.root, "versions")); !slices.Equal(got, []string{"1.0.0"}) {
		t.Fatalf("versions %v", got)
	}
	if s := siblings(t, f.state); len(s) != 0 {
		t.Fatalf("siblings %v", s)
	}
}

func TestAdvisory4AdoptionThatFailsWhileStagingRecordsNoPointerAndNoStateFolder(t *testing.T) {
	if os.Geteuid() == 0 || runtime.GOOS == "windows" {
		t.Skip("permission bits do not stop this user")
	}
	dir := t.TempDir()
	state := filepath.Join(dir, "state")
	makeState(t, state)
	old := filepath.Join(dir, "old")
	makePackage(t, old, "0.9.0")
	root := filepath.Join(dir, "install")
	release := filepath.Join(dir, "release")
	writeRelease(t, release, "1.0.0")
	if err := os.Chmod(filepath.Join(release, "package/web/index.html"), 0); err != nil {
		t.Fatal(err)
	}
	_, err := Update(context.Background(), UpdateOptions{
		Root: root, Release: release, Verifier: &fakeVerifier{}, Adopt: &Adoption{Dir: old, StateDir: state},
		TrustKey: []byte("k"), Migrate: noop, Ready: noop,
	})
	if !errors.Is(err, os.ErrPermission) {
		t.Fatalf("want a permission error, got %v", err)
	}
	if c, _ := ReadCurrent(root); c != nil {
		t.Fatal("a pointer was written")
	}
	if got := strings.Join(names(t, root), ","); got != "update.log,versions" {
		t.Fatalf("root holds %s", got)
	}
	if got := names(t, filepath.Join(root, "versions")); len(got) != 0 {
		t.Fatalf("versions %v", got)
	}
	lines := logLines(t, root)
	if len(lines) != 1 || lines[0]["event"] != "failed" {
		t.Fatalf("log %v", lines)
	}
}

func TestExpectVersionRefusesAnyOtherVersion(t *testing.T) {
	f := newFixture(t, t.TempDir())
	_, err := Update(context.Background(), UpdateOptions{
		Root: f.root, Release: f.release("1.1.0"), Verifier: f.verifier, Migrate: noop, Ready: noop, ExpectVersion: "1.2.0",
	})
	e := wantCode(t, err, CodeRefused, "expect")
	if e.Message != "The release holds 1.1.0, not the requested 1.2.0" {
		t.Fatalf("message %q", e.Message)
	}
}

func TestStagedVersionCarriesTheVerifiedManifestAndSignatureAndPassesInspection(t *testing.T) {
	f := newFixture(t, t.TempDir())
	release := f.release("1.1.0")
	if _, err := f.update(release, noop, noop); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"release.json", "release.sig"} {
		if readText(t, filepath.Join(f.root, "versions/1.1.0", name)) != readText(t, filepath.Join(release, name)) {
			t.Fatalf("%s differs from the verified bytes", name)
		}
	}
	got, err := InspectInstall(f.root)
	if err != nil || !got.Complete || got.Version != "1.1.0" {
		t.Fatalf("%v %+v", err, got)
	}
	put(t, filepath.Join(f.root, "versions/1.1.0/web/index.html"), "tampered", 0)
	if got, _ := InspectInstall(f.root); got.Complete || got.Reason != "web/index.html differs" {
		t.Fatalf("tampered: %+v", got)
	}
}

func TestStagingRefusesAFileThatDoesNotMatchTheSignedHashAndLeavesNoStaging(t *testing.T) {
	f := newFixture(t, t.TempDir())
	release := f.release("1.1.0")
	put(t, filepath.Join(release, "package/web/index.html"), "changed after signing", 0)
	_, err := f.update(release, noop, noop)
	e := wantCode(t, err, CodeRefused, "hash")
	if e.Message != "File does not match the signed release: web/index.html" {
		t.Fatalf("message %q", e.Message)
	}
	if got := names(t, filepath.Join(f.root, "versions")); !slices.Equal(got, []string{"1.0.0"}) {
		t.Fatalf("versions %v", got)
	}
	put(t, filepath.Join(release, "package/web/extra.html"), "unlisted", 0)
	_, err = f.update(release, noop, noop)
	e = wantCode(t, err, CodeRefused, "unlisted")
	if e.Message != "The release package does not match its manifest: unlisted web/extra.html" {
		t.Fatalf("message %q", e.Message)
	}
}

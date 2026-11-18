package desktopupdate

// Port of the library cases of deploy/desktop/updater/first-start.test.mjs: the data of an older
// install opens only through a dated copy and a rehearsal on a second copy.

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
)

func firstStartFixture(t *testing.T, dir string, withState bool) *fixtureT {
	t.Helper()
	return newFixtureAt(t, dir, filepath.Join(dir, "data", "SIPGES"), withState)
}

func breaking(calls *[]string) Hook {
	return func(_ context.Context, target Target) error {
		*calls = append(*calls, target.StateDir)
		_ = os.WriteFile(filepath.Join(target.StateDir, "pglite", "PG_VERSION"), []byte("half-migrated\n"), 0o600)
		return errors.New("migration 0033 failed")
	}
}

func migrating(calls *[]string) Hook {
	return func(_ context.Context, target Target) error {
		*calls = append(*calls, target.StateDir)
		return os.WriteFile(filepath.Join(target.StateDir, "pglite", "migrated"), []byte("yes\n"), 0o600)
	}
}

func named(list []string, kind string) []string {
	var out []string
	for _, name := range list {
		if strings.Contains(name, "."+kind+"-") {
			out = append(out, name)
		}
	}
	return out
}

func runFirstStart(root string, migrate Hook, now func() time.Time) (FirstStartResult, error) {
	return FirstStart(context.Background(), FirstStartOptions{Root: root, Migrate: migrate, Now: now})
}

func TestFirstStartRuleAFailedMigrationLeavesTheOriginalStateUntouched(t *testing.T) {
	f := firstStartFixture(t, t.TempDir(), true)
	before := snapshot(t, f.state)
	var calls []string
	_, err := runFirstStart(f.root, breaking(&calls), nil)
	e := wantCode(t, err, CodeRolledBack, "rehearsal")
	if !strings.Contains(e.Message, "state folder was not touched") {
		t.Fatalf("message %q", e.Message)
	}
	if len(calls) != 1 || !regexp.MustCompile(`\.rehearsal-\d{8}T\d{6}Z-1\.0\.0$`).MatchString(calls[0]) {
		t.Fatalf("calls %v", calls)
	}
	assertSnapshot(t, snapshot(t, f.state), before, "state")
	around := siblings(t, f.state)
	if len(named(around, "failed")) != 0 {
		t.Fatal("something was restored")
	}
	copies := named(around, "pre-update")
	if len(copies) != 1 || !regexp.MustCompile(`^SIPGES\.pre-update-\d{8}T\d{6}Z-first-start-1\.0\.0$`).MatchString(copies[0]) {
		t.Fatalf("copies %v", copies)
	}
	copyPath := filepath.Join(filepath.Dir(f.state), copies[0])
	assertSnapshot(t, snapshot(t, copyPath), before, "pre-update copy")
	if err := os.RemoveAll(copyPath); err != nil {
		t.Fatal(err)
	}
	if _, err := runFirstStart(f.root, breaking(&calls), nil); err == nil {
		t.Fatal("not marked done: the next start tries again")
	}
	if len(calls) != 2 {
		t.Fatalf("calls %v", calls)
	}
	assertSnapshot(t, snapshot(t, f.state), before, "state again")
	var events []string
	for _, line := range logLines(t, f.root) {
		if ev, _ := line["event"].(string); strings.HasPrefix(ev, "first-start") {
			events = append(events, ev)
		}
	}
	if !slices.Equal(events, []string{"first-start-failed", "first-start-failed"}) {
		t.Fatalf("events %v", events)
	}
}

func TestFirstStartRuleAMigrationFailingOnlyOnTheRealFolderIsUndoneFromTheDatedCopy(t *testing.T) {
	f := firstStartFixture(t, t.TempDir(), true)
	before := snapshot(t, f.state)
	var calls []string
	migrate := func(ctx context.Context, target Target) error {
		if len(calls) == 0 {
			return migrating(&calls)(ctx, target)
		}
		return breaking(&calls)(ctx, target)
	}
	_, err := runFirstStart(f.root, migrate, nil)
	e := wantCode(t, err, CodeRolledBack, "real folder")
	if !strings.Contains(e.Message, "the state folder was restored from") {
		t.Fatalf("message %q", e.Message)
	}
	if len(calls) != 2 || calls[1] != f.state {
		t.Fatalf("calls %v", calls)
	}
	assertSnapshot(t, snapshot(t, f.state), before, "state")
	around := siblings(t, f.state)
	if len(named(around, "failed")) != 1 {
		t.Fatalf("the changed folder is kept aside: %v", around)
	}
	assertSnapshot(t, snapshot(t, filepath.Join(filepath.Dir(f.state), named(around, "pre-update")[0])), before, "copy")
	if c, _ := ReadCurrent(f.root); c.Version != "1.0.0" {
		t.Fatal("current")
	}
}

func TestFirstStartRuleATakesADatedCopyRehearsesThenMigrates(t *testing.T) {
	f := firstStartFixture(t, t.TempDir(), true)
	before := snapshot(t, f.state)
	var calls []string
	result, err := runFirstStart(f.root, migrating(&calls), func() time.Time { return time.Date(2026, 11, 11, 10, 20, 30, 0, time.UTC) })
	if err != nil {
		t.Fatal(err)
	}
	copyPath := f.state + ".pre-update-20261111T102030Z-first-start-1.0.0"
	if result != (FirstStartResult{Done: true, Version: "1.0.0", PreUpdateCopy: copyPath}) {
		t.Fatalf("result %+v", result)
	}
	if !slices.Equal(calls, []string{f.state + ".rehearsal-20261111T102030Z-1.0.0", f.state}) {
		t.Fatalf("calls %v", calls)
	}
	assertSnapshot(t, snapshot(t, copyPath), before, "copy")
	if readText(t, filepath.Join(f.state, "pglite", "migrated")) != "yes\n" {
		t.Fatal("not migrated")
	}
	var marker map[string]any
	if err := json.Unmarshal([]byte(readText(t, filepath.Join(f.root, "first-start.json"))), &marker); err != nil {
		t.Fatal(err)
	}
	if marker["format"] != float64(1) || marker["version"] != "1.0.0" || marker["stateDir"] != f.state || marker["preUpdateCopy"] != copyPath || marker["at"] != "2026-11-11T10:20:30.000Z" {
		t.Fatalf("marker %v", marker)
	}
	for _, line := range logLines(t, f.root) {
		if line["event"] == "first-start" && line["preUpdateCopy"] != copyPath {
			t.Fatalf("log %v", line)
		}
	}
}

func TestFirstStartRuleDASecondFirstStartChangesNothing(t *testing.T) {
	f := firstStartFixture(t, t.TempDir(), true)
	var calls []string
	if _, err := runFirstStart(f.root, migrating(&calls), nil); err != nil {
		t.Fatal(err)
	}
	state1, around1, root1 := snapshot(t, f.state), siblings(t, f.state), snapshot(t, f.root)
	again, err := runFirstStart(f.root, migrating(&calls), nil)
	if err != nil || again != (FirstStartResult{Done: false, Version: "1.0.0"}) {
		t.Fatalf("%v %+v", err, again)
	}
	if len(calls) != 2 {
		t.Fatal("a migration ran the second time")
	}
	assertSnapshot(t, snapshot(t, f.state), state1, "state")
	if !slices.Equal(siblings(t, f.state), around1) {
		t.Fatal("siblings changed")
	}
	assertSnapshot(t, snapshot(t, f.root), root1, "root")
}

func TestFirstStartFreshStateNeedsNoCopyAndIsOnlyRecorded(t *testing.T) {
	f := firstStartFixture(t, t.TempDir(), false)
	var calls []string
	result, err := runFirstStart(f.root, migrating(&calls), nil)
	if err != nil || result != (FirstStartResult{Done: true, Version: "1.0.0"}) {
		t.Fatalf("%v %+v", err, result)
	}
	if len(calls) != 0 {
		t.Fatal("migrated")
	}
	if exists(t, filepath.Dir(f.state)) {
		t.Fatal("something was created beside the state folder")
	}
	if !strings.Contains(readText(t, filepath.Join(f.root, "first-start.json")), `"version": "1.0.0"`) {
		t.Fatal("not recorded")
	}
}

func TestFirstStartRuleBADatabaseWithoutItsSecretsIsRefusedBeforeAnythingIsWritten(t *testing.T) {
	for _, secret := range []string{"data-key", "admin-password"} {
		t.Run(secret, func(t *testing.T) {
			dir := t.TempDir()
			state := filepath.Join(dir, "data", "SIPGES")
			makeState(t, state)
			put(t, filepath.Join(state, secret), "  \n", 0)
			f := newFixtureAt(t, dir, state, false)
			before := snapshot(t, state)
			var calls []string
			_, err := runFirstStart(f.root, migrating(&calls), nil)
			e := wantCode(t, err, CodeRefused, secret)
			if !strings.Contains(e.Message, filepath.Join(state, secret)) || !strings.Contains(e.Message, "restore it from the backup") {
				t.Fatalf("message %q", e.Message)
			}
			if len(calls) != 0 || len(siblings(t, state)) != 0 || exists(t, filepath.Join(f.root, "first-start.json")) {
				t.Fatal("something was written")
			}
			assertSnapshot(t, snapshot(t, state), before, "state")
		})
	}
}

func TestFirstStartTreatsAPostgreSQLDataFolderAsADatabase(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "data", "SIPGES")
	put(t, filepath.Join(state, "pg18", "PG_VERSION"), "18\n", 0)
	put(t, filepath.Join(state, "data-key"), "synthetic-key\n", 0o600)
	put(t, filepath.Join(state, "admin-password"), "synthetic-password\n", 0o600)
	f := newFixtureAt(t, dir, state, false)
	var calls []string
	result, err := runFirstStart(f.root, migrating2(&calls), nil)
	if err != nil || result.PreUpdateCopy == "" || len(calls) != 2 {
		t.Fatalf("%v %+v %v", err, result, calls)
	}
}

func migrating2(calls *[]string) Hook {
	return func(_ context.Context, target Target) error {
		*calls = append(*calls, target.StateDir)
		return nil
	}
}

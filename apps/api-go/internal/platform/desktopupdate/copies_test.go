package desktopupdate

// Port of the library cases of deploy/desktop/updater/copies.test.mjs: copies beside the state
// folder are never deleted automatically, and the newest pre-update copy is never removed.

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func daysAgo(days int) time.Time { return time.Now().Add(-time.Duration(days) * 24 * time.Hour) }

// stateCopy makes a copy beside the state folder as the updater names it, holding bytes bytes.
func stateCopy(t *testing.T, state, kind string, date time.Time, suffix string) string {
	t.Helper()
	path := state + "." + kind + "-" + stamp(date) + "-" + suffix
	put(t, filepath.Join(path, "pglite", "PG_VERSION"), strings.Repeat("x", 100), 0)
	return path
}

func TestCopiesFirstStartRecordsItsCopiesAndTheListCountsThemAndNothingElse(t *testing.T) {
	f := firstStartFixture(t, t.TempDir(), true)
	result, err := runFirstStart(f.root, noop, nil)
	if err != nil {
		t.Fatal(err)
	}
	var rehearsal string
	for _, line := range logLines(t, f.root) {
		if line["event"] == "first-start" {
			rehearsal, _ = line["rehearsalCopy"].(string)
		}
	}
	if !strings.Contains(rehearsal, ".rehearsal-") {
		t.Fatalf("rehearsal copy not logged: %q", rehearsal)
	}
	put(t, filepath.Join(f.state+".pre-update-20200101T000000Z-x.partial", "f"), "partial", 0)
	put(t, filepath.Join(f.state+"-otro", "f"), "other", 0)
	put(t, f.state+".pre-update-notes.txt", "a file", 0)
	listed, err := ListStateCopies(f.root)
	if err != nil {
		t.Fatal(err)
	}
	if listed.StateDir != f.state || listed.Count != 2 {
		t.Fatalf("listed %+v", listed)
	}
	if listed.Copies[0].Kind != "pre-update" || listed.Copies[0].Path != result.PreUpdateCopy ||
		listed.Copies[1].Kind != "rehearsal" || listed.Copies[1].Path != rehearsal {
		t.Fatalf("copies %+v", listed.Copies)
	}
	if listed.Bytes <= 8192*2 || listed.Bytes != listed.Copies[0].Bytes+listed.Copies[1].Bytes {
		t.Fatalf("bytes %d", listed.Bytes)
	}
	if listed.NewestPreUpdate != result.PreUpdateCopy {
		t.Fatalf("newest %q", listed.NewestPreUpdate)
	}
}

func TestCopiesRemovingOldCopiesNeverRemovesTheNewestPreUpdateCopy(t *testing.T) {
	f := firstStartFixture(t, t.TempDir(), true)
	oldest := stateCopy(t, f.state, "pre-update", daysAgo(90), "first-start-1.0.0")
	rehearsal := stateCopy(t, f.state, "rehearsal", daysAgo(90), "1.0.0")
	failed := stateCopy(t, f.state, "failed", daysAgo(50), "1.1.0")
	newest := stateCopy(t, f.state, "pre-update", daysAgo(40), "1.0.0-to-1.1.0")
	recent := stateCopy(t, f.state, "rehearsal", daysAgo(2), "1.2.0")
	result, err := RemoveStateCopies(context.Background(), RemoveOptions{Root: f.root, OlderThanDays: 30})
	if err != nil {
		t.Fatal(err)
	}
	var removed []string
	for _, c := range result.Removed {
		removed = append(removed, c.Path)
	}
	slices.Sort(removed)
	want := []string{failed, oldest, rehearsal}
	slices.Sort(want)
	if !slices.Equal(removed, want) || result.Kept != newest || result.Left != 2 {
		t.Fatalf("result %+v", result)
	}
	var left []string
	for _, name := range siblings(t, f.state) {
		left = append(left, filepath.Join(filepath.Dir(f.state), name))
	}
	if !slices.Equal(left, []string{newest, recent}) {
		t.Fatalf("left %v", left)
	}
	for _, line := range logLines(t, f.root) {
		if line["event"] == "copies-removed" {
			if line["olderThanDays"] != float64(30) || line["kept"] != newest || len(line["removed"].([]any)) != 3 {
				t.Fatalf("log %v", line)
			}
			return
		}
	}
	t.Fatal("copies-removed not logged")
}

func TestCopiesRemovingIsRefusedWhileAnUpdateIsPendingAndForABadAge(t *testing.T) {
	f := firstStartFixture(t, t.TempDir(), true)
	stateCopy(t, f.state, "pre-update", daysAgo(60), "first-start-1.0.0")
	stateCopy(t, f.state, "rehearsal", daysAgo(60), "1.0.0")
	before := siblings(t, f.state)
	for _, days := range []int{0, -3} {
		_, err := RemoveStateCopies(context.Background(), RemoveOptions{Root: f.root, OlderThanDays: days})
		e := wantCode(t, err, CodeRefused, "bad age")
		if !strings.Contains(e.Message, "whole number of days") {
			t.Fatalf("message %q", e.Message)
		}
	}
	put(t, filepath.Join(f.root, "update-journal.json"), "{\"phase\":\"migrating\"}\n", 0)
	_, err := RemoveStateCopies(context.Background(), RemoveOptions{Root: f.root, OlderThanDays: 30})
	e := wantCode(t, err, CodeRefused, "pending")
	if !strings.HasPrefix(e.Message, "An update is pending or halted") {
		t.Fatalf("message %q", e.Message)
	}
	if !slices.Equal(siblings(t, f.state), before) || !exists(t, filepath.Join(f.root, "update-journal.json")) {
		t.Fatal("something changed")
	}
}

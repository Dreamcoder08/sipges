package desktopupdate

// Port of deploy/desktop/updater/rename-retry.test.mjs. The clock and the pause are injected:
// these tests take no real time.

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

type fakeWindows struct {
	clock  time.Duration
	waits  []time.Duration
	calls  [][2]string
	errs   []error
	opts   renameOptions
	failAt int
}

// newFakeWindows returns rename options whose clock only the pause (and a slow rename) moves,
// and whose rename fails `failures` times with `code` (-1 for always).
func newFakeWindows(failures int, code syscall.Errno, renameTime time.Duration) *fakeWindows {
	w := &fakeWindows{failAt: failures}
	w.opts = renameOptions{
		windows: true,
		now:     func() time.Time { return time.Unix(0, 0).Add(w.clock) },
		wait: func(d time.Duration) {
			w.waits = append(w.waits, d)
			w.clock += d
		},
		move: func(from, to string) error {
			w.calls = append(w.calls, [2]string{from, to})
			w.clock += renameTime
			if w.failAt >= 0 && len(w.calls) > w.failAt {
				return nil
			}
			err := &os.LinkError{Op: "rename", Old: from, New: to, Err: code}
			w.errs = append(w.errs, err)
			return err
		},
	}
	return w
}

func total(waits []time.Duration) time.Duration {
	var sum time.Duration
	for _, w := range waits {
		sum += w
	}
	return sum
}

func TestRenameHeldForGoodRetriesThirtyToSixtySecondsThenThrowsLastError(t *testing.T) {
	w := newFakeWindows(-1, syscall.EPERM, 0)
	err := renameRetry("a", "b", w.opts)
	if err == nil || err != w.errs[len(w.errs)-1] { //nolint:errorlint // the very error of the last attempt
		t.Fatalf("want the last error unchanged, got %v", err)
	}
	if !errors.Is(err, syscall.EPERM) {
		t.Fatalf("code: %v", err)
	}
	if s := total(w.waits); s < 30*time.Second || s > 60*time.Second {
		t.Fatalf("waited %v in all", s)
	}
	if len(w.calls) != len(w.waits)+1 {
		t.Fatalf("one more attempt than pauses: %d calls, %d waits", len(w.calls), len(w.waits))
	}
	for _, c := range w.calls {
		if c != [2]string{"a", "b"} {
			t.Fatalf("the same rename every time: %v", c)
		}
	}
	if w.waits[0] != 100*time.Millisecond {
		t.Fatalf("the first pause is short: %v", w.waits[0])
	}
	for i := 1; i < len(w.waits); i++ {
		if w.waits[i] < w.waits[i-1] && i != len(w.waits)-1 {
			t.Fatalf("pauses grow: %v", w.waits)
		}
		if w.waits[i] > 2*time.Second {
			t.Fatalf("no single pause is long: %v", w.waits[i])
		}
	}
}

func TestRenameSlowRefusalsCountAgainstTheSameBudget(t *testing.T) {
	w := newFakeWindows(-1, syscall.EPERM, 5*time.Second)
	if err := renameRetry("a", "b", w.opts); !errors.Is(err, syscall.EPERM) {
		t.Fatalf("want EPERM, got %v", err)
	}
	if w.clock > 65*time.Second || w.clock < 30*time.Second {
		t.Fatalf("gave up after %v", w.clock)
	}
}

func TestRenameEACCESAndEBUSYAreWaitedForLikeEPERM(t *testing.T) {
	for _, code := range []syscall.Errno{syscall.EACCES, syscall.EBUSY} {
		w := newFakeWindows(3, code, 0)
		if err := renameRetry("a", "b", w.opts); err != nil {
			t.Fatal(err)
		}
		want := []time.Duration{100 * time.Millisecond, 200 * time.Millisecond, 400 * time.Millisecond}
		if len(w.waits) != 3 || w.waits[0] != want[0] || w.waits[1] != want[1] || w.waits[2] != want[2] {
			t.Fatalf("%v: waits %v", code, w.waits)
		}
		if len(w.calls) != 4 {
			t.Fatalf("%v: calls %d", code, len(w.calls))
		}
	}
}

func TestRenameHoldReleasedAfterTwentySecondsNoLongerFails(t *testing.T) {
	w := newFakeWindows(25, syscall.EPERM, 0)
	if err := renameRetry("a", "b", w.opts); err != nil {
		t.Fatal(err)
	}
	if total(w.waits) <= 20*time.Second || len(w.calls) != 26 {
		t.Fatalf("waited %v, %d calls", total(w.waits), len(w.calls))
	}
}

func TestRenamePreservedFirstTrySuccessDoesNotWait(t *testing.T) {
	w := newFakeWindows(0, syscall.EPERM, 0)
	if err := renameRetry("a", "b", w.opts); err != nil {
		t.Fatal(err)
	}
	if len(w.waits) != 0 || len(w.calls) != 1 {
		t.Fatalf("waits %v calls %v", w.waits, w.calls)
	}
}

func TestRenamePreservedOtherErrorsAreThrownAtOnce(t *testing.T) {
	w := newFakeWindows(-1, syscall.ENOENT, 0)
	if err := renameRetry("a", "b", w.opts); err != w.errs[0] { //nolint:errorlint // the very error of the first attempt
		t.Fatalf("want the first error, got %v", err)
	}
	if len(w.waits) != 0 || len(w.calls) != 1 {
		t.Fatalf("waits %v calls %d", w.waits, len(w.calls))
	}
}

func TestRenamePreservedOffWindowsRefusalIsThrownAtOnce(t *testing.T) {
	w := newFakeWindows(-1, syscall.EPERM, 0)
	w.opts.windows = false
	if err := renameRetry("a", "b", w.opts); !errors.Is(err, syscall.EPERM) {
		t.Fatalf("want EPERM, got %v", err)
	}
	if len(w.waits) != 0 || len(w.calls) != 1 {
		t.Fatalf("waits %v calls %d", w.waits, len(w.calls))
	}
}

func TestRenamePreservedRealDefaultsRenameAtOnce(t *testing.T) {
	dir := t.TempDir()
	from := filepath.Join(dir, "from")
	put(t, filepath.Join(from, "file"), "synthetic\n", 0)
	started := time.Now()
	if err := RenameRetry(from, filepath.Join(dir, "to")); err != nil {
		t.Fatal(err)
	}
	if time.Since(started) > time.Second || exists(t, from) {
		t.Fatal("not renamed at once")
	}
	if readText(t, filepath.Join(dir, "to", "file")) != "synthetic\n" {
		t.Fatal("content")
	}
}

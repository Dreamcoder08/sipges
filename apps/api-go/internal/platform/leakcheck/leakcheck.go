// Package leakcheck fails a test binary that leaves leaked goroutines behind.
//
// It reads the runtime's goroutineleak profile (generally available since Go 1.27). A goroutine
// counts as leaked when it is blocked on a concurrency primitive (channel, sync.Mutex, sync.Cond,
// …) that no runnable goroutine can reach, so it can never wake up. Goroutines blocked on I/O, on
// a timer, or on a primitive reachable through a global variable are not reported.
//
// Use it from TestMain, after the tests ran:
//
//	func TestMain(m *testing.M) { os.Exit(leakcheck.After(m.Run())) }
package leakcheck

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"regexp"
	"runtime/pprof"
	"strconv"
)

// After returns code unchanged when the tests failed (code != 0) or nothing leaked. When the tests
// passed but goroutines leaked, it writes their stacks to stderr and returns 1.
func After(code int) int { return after(code, os.Stderr, report) }

func after(code int, out io.Writer, leaks func() (int, string)) int {
	if code != 0 {
		return code
	}
	count, stacks := leaks()
	if count == 0 {
		return 0
	}
	// The exit code carries the failure; a lost report must not hide it.
	_, _ = fmt.Fprintf(out, "leakcheck: %d leaked goroutine(s) after the tests passed\n%s", count, stacks)
	return 1
}

var totalLine = regexp.MustCompile(`(?m)^goroutineleak profile: total (\d+)$`)

// report runs leak detection and returns the number of leaked goroutines with their stacks.
// Profile.Count alone does not detect anything: detection runs while the profile is written.
func report() (int, string) {
	p := pprof.Lookup("goroutineleak")
	if p == nil {
		return 0, ""
	}
	var b bytes.Buffer
	if err := p.WriteTo(&b, 1); err != nil {
		return 0, ""
	}
	m := totalLine.FindSubmatch(b.Bytes())
	if m == nil {
		return 0, b.String()
	}
	n, err := strconv.Atoi(string(m[1]))
	if err != nil {
		return 0, b.String()
	}
	return n, b.String()
}

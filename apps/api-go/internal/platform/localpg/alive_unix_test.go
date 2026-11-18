//go:build !windows

package localpg

import (
	"errors"
	"syscall"
)

// alive reports whether a process with this id still runs: signal 0 reaches it, or exists but
// belongs to someone else (EPERM).
func alive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// killHard ends the process at once, as a crash would.
func killHard(pid int) error { return syscall.Kill(pid, syscall.SIGKILL) }

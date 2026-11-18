//go:build !windows

package localpg

import (
	"errors"
	"os/exec"
	"syscall"
)

// hideWindow matters only on Windows.
func hideWindow(*exec.Cmd) {}

// processAlive reports whether a process with this id runs: signal 0 reaches it, or it exists
// under another user (EPERM).
func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

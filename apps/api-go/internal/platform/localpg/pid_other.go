//go:build !windows

package localpg

import (
	"errors"
	"syscall"
)

// pidAlive reports whether a process with this id exists: signal 0 reaches it, or it belongs to
// someone else (EPERM).
func pidAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

//go:build windows

package localpg

import (
	"errors"
	"os"
	"syscall"
	"unsafe"
)

// lockFlags is LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY; 33 is ERROR_LOCK_VIOLATION.
const lockFlags, errorLockViolation = 0x2 | 0x1, syscall.Errno(33)

var lockFileEx = syscall.NewLazyDLL("kernel32.dll").NewProc("LockFileEx")

// lockFile takes a non-blocking exclusive LockFileEx on the first byte; Windows drops it when the
// handle closes or the process ends.
func lockFile(f *os.File) error {
	var overlapped syscall.Overlapped
	r, _, err := lockFileEx.Call(f.Fd(), lockFlags, 0, 1, 0, uintptr(unsafe.Pointer(&overlapped)))
	if r != 0 {
		return nil
	}
	if errors.Is(err, errorLockViolation) {
		return errLocked
	}
	return err
}

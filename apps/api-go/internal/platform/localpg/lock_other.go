//go:build !windows

package localpg

import (
	"errors"
	"os"
	"syscall"
)

// lockFile takes a non-blocking exclusive flock; the kernel drops it when the process ends.
func lockFile(f *os.File) error {
	err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return errLocked
	}
	return err
}

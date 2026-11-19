//go:build !linux && !windows

package localpg

import (
	"errors"
	"syscall"
)

// identify is unknown where the system does not describe a process's folder or program.
func identify(int, string) identity { return identityUnknown }

// connectionRefused reports a connection the system refused: nothing listens on the port.
func connectionRefused(err error) bool { return errors.Is(err, syscall.ECONNREFUSED) }

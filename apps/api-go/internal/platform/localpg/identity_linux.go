//go:build linux

package localpg

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// identify proves what the process is from /proc: a postmaster works in its data folder (it
// changes to it before it writes postmaster.pid) and runs the postgres program. Another folder or
// another program is not PostgreSQL on dir; a process the system does not describe (another
// user's) is unknown.
func identify(pid int, dir string) identity {
	proc := filepath.Join("/proc", strconv.Itoa(pid))
	cwd, err := os.Readlink(filepath.Join(proc, "cwd"))
	if err != nil {
		return identityUnknown
	}
	want, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return identityUnknown
	}
	if filepath.Clean(cwd) != filepath.Clean(want) {
		return identityOther
	}
	exe, err := os.Readlink(filepath.Join(proc, "exe"))
	if err == nil && filepath.Base(strings.TrimSuffix(exe, " (deleted)")) != "postgres" {
		return identityOther
	}
	return identityPostgres
}

// connectionRefused reports a connection the system refused: nothing listens on the port.
func connectionRefused(err error) bool { return errors.Is(err, syscall.ECONNREFUSED) }

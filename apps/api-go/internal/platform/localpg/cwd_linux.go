//go:build linux

package localpg

import (
	"os"
	"path/filepath"
	"strconv"
)

// processInDir reports whether the process works in dir, as a postmaster works in its data
// folder. known is false when the system does not tell (another user's process).
func processInDir(pid int, dir string) (known, in bool) {
	cwd, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "cwd"))
	if err != nil {
		return false, false
	}
	want, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return false, false
	}
	return true, filepath.Clean(cwd) == filepath.Clean(want)
}

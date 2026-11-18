//go:build !windows

package desktopupdate

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// alive reports whether a process with this id still runs: signal 0 reaches it, or it exists
// but belongs to someone else (EPERM), as Node's process.kill(pid, 0) does.
func alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// renameHeld reports the refusals Node's renameRetry waits for (EPERM, EACCES, EBUSY).
func renameHeld(err error) bool {
	return errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EBUSY)
}

// diskFree is the room for an unprivileged user: available blocks times the block size.
func diskFree(path string) (Disk, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return Disk{}, &fs.PathError{Op: "statfs", Path: path, Err: err}
	}
	return Disk{Avail: uint64(stat.Bavail), BlockSize: uint64(stat.Bsize)}, nil //nolint:unconvert,gosec // field types differ by OS
}

// realPath resolves every link of an existing path.
func realPath(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	return filepath.Abs(resolved)
}

// makeDirLink creates the relative directory link a release lists. finalTarget is unused here:
// only Windows junctions need an absolute target.
func makeDirLink(target, _ string, path string) error {
	if err := os.Symlink(target, path); err != nil {
		return err
	}
	got, err := os.Readlink(path)
	if err != nil {
		return err
	}
	if got != target {
		return refuse("Link was not created as signed: %s", path)
	}
	return nil
}

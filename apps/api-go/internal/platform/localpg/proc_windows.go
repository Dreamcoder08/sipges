//go:build windows

package localpg

import (
	"os/exec"
	"syscall"
)

// createNoWindow keeps initdb, pg_ctl and the server they start from opening a console window
// and from receiving the console's Ctrl+C: the desktop stops the server itself, with a fast stop.
const createNoWindow = 0x08000000

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// stillActive is STILL_ACTIVE, the exit code of a process that has not exited.
const stillActive = 259

// processAlive reports whether a process with this id runs and has not exited.
func processAlive(pid int) bool {
	h, err := syscall.OpenProcess(syscall.PROCESS_QUERY_INFORMATION, false, uint32(pid)) //nolint:gosec // G115: a pid from our own lock file
	if err != nil {
		return false
	}
	defer func() { _ = syscall.CloseHandle(h) }()
	var code uint32
	return syscall.GetExitCodeProcess(h, &code) == nil && code == stillActive
}

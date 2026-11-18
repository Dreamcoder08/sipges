//go:build windows

package doctext

import (
	"os/exec"
	"syscall"
)

// ownProcessGroup starts cmd in a new process group, the closest Windows has to a Unix one.
func ownProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
}

// killProcessGroup kills cmd. Windows does not kill a process's children with it; OCR is a
// server feature and the desktop install does not configure it (ADR 0036).
func killProcessGroup(cmd *exec.Cmd) error {
	return cmd.Process.Kill()
}

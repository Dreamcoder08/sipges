//go:build !windows

package doctext

import (
	"os/exec"
	"syscall"
)

// ownProcessGroup starts cmd as the leader of a new process group.
func ownProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcessGroup kills cmd and every process it started; an empty group answers ESRCH.
func killProcessGroup(cmd *exec.Cmd) error {
	return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}

//go:build linux

package main

import (
	"os"
	"os/exec"
	"syscall"
)

// ownProcessGroup makes the kernel kill the API when this launcher dies, however it ended (a
// hard kill runs no handler), so no API outlives its launcher (boot.mjs PARENT_WATCH).
func ownProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}

// bindToLauncher matters only on Windows; Pdeathsig does it here.
func bindToLauncher(*os.Process) {}

// interrupt asks the API to stop as the Compose stop does.
func interrupt(p *os.Process) error { return p.Signal(syscall.SIGTERM) }

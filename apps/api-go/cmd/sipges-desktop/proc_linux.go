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

// interrupt asks the API to stop as the Compose stop does.
func interrupt(p *os.Process) error { return p.Signal(syscall.SIGTERM) }

// joinLauncherJob matters only on Windows: here a PostgreSQL that a killed launcher left running
// is stopped by the next start, before recovery (stopOrphanClusters).
func joinLauncherJob() {}

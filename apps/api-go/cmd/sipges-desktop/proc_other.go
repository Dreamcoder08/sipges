//go:build !windows && !linux

package main

import (
	"os"
	"os/exec"
	"syscall"
)

// ownProcessGroup has nothing to set here: without a parent death signal, a launcher killed hard
// leaves its API to the next start (localpg stops a PostgreSQL left running).
func ownProcessGroup(*exec.Cmd) {}

// interrupt asks the API to stop as the Compose stop does.
func interrupt(p *os.Process) error { return p.Signal(syscall.SIGTERM) }

// joinLauncherJob matters only on Windows: here a PostgreSQL that a killed launcher left running
// is stopped by the next start, before recovery (stopOrphanClusters).
func joinLauncherJob() {}

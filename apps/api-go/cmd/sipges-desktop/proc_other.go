//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

func ownProcessGroup(*exec.Cmd) {}

// interrupt asks the API to stop as the Compose stop does.
func interrupt(p *os.Process) error { return p.Signal(syscall.SIGTERM) }

//go:build !windows

package localpg

import "os/exec"

// hideWindow matters only on Windows.
func hideWindow(*exec.Cmd) {}

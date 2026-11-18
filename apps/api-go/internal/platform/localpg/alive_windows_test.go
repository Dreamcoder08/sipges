//go:build windows

package localpg

import "os"

// alive reports whether a process with this id still runs: Windows opens only existing processes.
func alive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	_ = p.Release()
	return true
}

// killHard ends the process at once, as a crash would.
func killHard(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}

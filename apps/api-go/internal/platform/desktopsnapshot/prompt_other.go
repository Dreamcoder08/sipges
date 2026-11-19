//go:build !windows

package desktopsnapshot

import (
	"os"
	"os/exec"
	"strings"
)

// stty runs on the terminal itself; the standard library cannot turn echo off.
func stty(f *os.File, args ...string) (string, error) {
	cmd := exec.Command("stty", args...) //nolint:noctx,gosec // restoring the terminal must outlive the run; our own arguments
	cmd.Stdin = f
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

// hideTyping turns echo off until restore puts the saved settings back.
func hideTyping(f *os.File) (func(), error) {
	saved, err := stty(f, "-g")
	if err == nil {
		_, err = stty(f, "-echo")
	}
	if err != nil {
		return nil, errNoHiddenPrompt
	}
	return func() { _, _ = stty(f, saved) }, nil
}

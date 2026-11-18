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

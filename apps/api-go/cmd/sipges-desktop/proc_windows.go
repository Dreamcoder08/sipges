//go:build windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

// ctrlBreakEvent is CTRL_BREAK_EVENT; Go's os/signal delivers it to the API as os.Interrupt.
const ctrlBreakEvent = 1

var generateConsoleCtrlEvent = syscall.NewLazyDLL("kernel32.dll").NewProc("GenerateConsoleCtrlEvent")

// ownProcessGroup puts the API in a process group of its own, so a Ctrl+C in the console reaches
// this process first, which then stops the API and PostgreSQL in order.
func ownProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
}

// interrupt sends Ctrl+Break to the API's group for a graceful stop. Without a console to send it
// through, the API is killed: its open transactions roll back in PostgreSQL.
func interrupt(p *os.Process) error {
	if r, _, _ := generateConsoleCtrlEvent.Call(ctrlBreakEvent, uintptr(p.Pid)); r != 0 {
		return nil
	}
	return p.Kill()
}

package desktopsnapshot

import (
	"os"
	"syscall"
)

// enableEchoInput is ENABLE_ECHO_INPUT of the Windows console input mode.
const enableEchoInput = 0x0004

var (
	kernel32           = syscall.NewLazyDLL("kernel32.dll")
	procSetConsoleMode = kernel32.NewProc("SetConsoleMode")
)

func consoleMode(f *os.File) (uint32, bool) {
	var mode uint32
	err := syscall.GetConsoleMode(syscall.Handle(f.Fd()), &mode)
	return mode, err == nil
}

func setConsoleMode(f *os.File, mode uint32) error {
	ok, _, err := procSetConsoleMode.Call(f.Fd(), uintptr(mode))
	if ok == 0 {
		return err
	}
	return nil
}

// isTerminal reports a console: a person typing, not a pipe or a file.
func isTerminal(f *os.File) bool {
	_, ok := consoleMode(f)
	return ok
}

// hideTyping turns the console's echo off until restore puts the saved mode back.
func hideTyping(f *os.File) (func(), error) {
	mode, ok := consoleMode(f)
	if !ok || setConsoleMode(f, mode&^enableEchoInput) != nil {
		return nil, errNoHiddenPrompt
	}
	return func() { _ = setConsoleMode(f, mode) }, nil
}

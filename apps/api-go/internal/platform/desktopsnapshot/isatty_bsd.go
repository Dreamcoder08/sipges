//go:build darwin || freebsd || netbsd || openbsd || dragonfly

package desktopsnapshot

import (
	"os"
	"syscall"
	"unsafe"
)

// isTerminal is isatty(3), as Node's process.stdin.isTTY: the terminal settings can be read.
// /dev/null and files are not terminals.
func isTerminal(f *os.File) bool {
	var settings syscall.Termios
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), syscall.TIOCGETA, uintptr(unsafe.Pointer(&settings))) //nolint:gosec // isatty: the kernel fills a Termios we own
	return errno == 0
}

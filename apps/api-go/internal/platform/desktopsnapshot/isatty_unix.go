//go:build !windows && !linux && !darwin && !freebsd && !netbsd && !openbsd && !dragonfly

package desktopsnapshot

import "os"

// isTerminal is isatty(3) where the standard library has no terminal ioctl: stty reads the
// settings of a terminal only.
func isTerminal(f *os.File) bool {
	_, err := stty(f, "-g")
	return err == nil
}

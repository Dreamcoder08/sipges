//go:build windows

package desktopupdate

import "errors"

func mkfifo(string) error { return errors.New("no named pipes in the file system on Windows") }

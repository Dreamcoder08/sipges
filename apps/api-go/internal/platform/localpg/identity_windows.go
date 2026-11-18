//go:build windows

package localpg

import (
	"errors"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

// wsaeConnRefused is WSAECONNREFUSED, the error a refused connection carries on Windows.
const wsaeConnRefused = syscall.Errno(10061)

var queryFullProcessImageName = syscall.NewLazyDLL("kernel32.dll").NewProc("QueryFullProcessImageNameW")

// identify proves what the process is from its image: postgres.exe is PostgreSQL, any other
// program is not. Windows does not tell a process's working folder, so a postgres.exe counts for
// dir. A process that cannot be opened or named is unknown.
func identify(pid int, _ string) identity {
	if pid <= 0 {
		return identityUnknown
	}
	handle, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid)) //nolint:gosec // pid > 0
	if err != nil {
		return identityUnknown
	}
	defer func() { _ = syscall.CloseHandle(handle) }()
	var buf [syscall.MAX_LONG_PATH]uint16
	size := uint32(syscall.MAX_LONG_PATH)
	ok, _, _ := queryFullProcessImageName.Call(uintptr(handle), 0,
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size))) //nolint:gosec // G103: Win32 call with a sized buffer
	if ok == 0 || size == 0 || int(size) > len(buf) {
		return identityUnknown
	}
	if strings.EqualFold(filepath.Base(syscall.UTF16ToString(buf[:size])), "postgres.exe") {
		return identityPostgres
	}
	return identityOther
}

// connectionRefused reports a connection the system refused: nothing listens on the port.
func connectionRefused(err error) bool {
	return errors.Is(err, wsaeConnRefused) || errors.Is(err, syscall.ECONNREFUSED)
}

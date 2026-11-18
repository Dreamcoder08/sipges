//go:build windows

package desktopupdate

import (
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

const (
	processQueryLimitedInformation = 0x1000
	stillActive                    = 259
	errorSharingViolation          = syscall.Errno(32)
	errorLockViolation             = syscall.Errno(33)
	errorNoAccess                  = syscall.Errno(998)
	errorElevationRequired         = syscall.Errno(740)
	errorCantAccessFile            = syscall.Errno(1920)
	fsctlSetReparsePoint           = 0x000900A4
	ioReparseTagMountPoint         = 0xA0000003
)

var (
	kernel32                  = syscall.NewLazyDLL("kernel32.dll")
	getDiskFreeSpaceExW       = kernel32.NewProc("GetDiskFreeSpaceExW")
	getFinalPathNameByHandleW = kernel32.NewProc("GetFinalPathNameByHandleW")
)

// alive reports whether a process with this id still runs, as Node's process.kill(pid, 0) does
// through libuv: a process that cannot be opened for lack of rights still exists.
func alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid)) //nolint:gosec // pid > 0
	if err != nil {
		return errors.Is(err, syscall.ERROR_ACCESS_DENIED)
	}
	defer func() { _ = syscall.CloseHandle(handle) }()
	var code uint32
	if err := syscall.GetExitCodeProcess(handle, &code); err != nil {
		return true
	}
	return code == stillActive
}

// renameHeld reports the Windows errors libuv maps to EPERM, EACCES or EBUSY: a file or folder
// another process holds for a moment.
func renameHeld(err error) bool {
	for _, code := range []syscall.Errno{
		syscall.ERROR_ACCESS_DENIED, errorSharingViolation, errorLockViolation,
		errorNoAccess, errorElevationRequired, errorCantAccessFile,
	} {
		if errors.Is(err, code) {
			return true
		}
	}
	return false
}

// diskFree is the room available to this user on the volume of path, in bytes.
func diskFree(path string) (Disk, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return Disk{}, err
	}
	var available, total, free uint64
	r, _, callErr := getDiskFreeSpaceExW.Call(uintptr(unsafe.Pointer(name)), //nolint:gosec // Windows API call
		uintptr(unsafe.Pointer(&available)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&free))) //nolint:gosec // Windows API call
	if r == 0 {
		return Disk{}, &os.PathError{Op: "GetDiskFreeSpaceEx", Path: path, Err: callErr}
	}
	return Disk{Avail: available, BlockSize: 1}, nil
}

// realPath resolves links and junctions of an existing path with GetFinalPathNameByHandle, as
// Node's realpath does (filepath.EvalSymlinks no longer follows junctions since Go 1.23).
func realPath(path string) (string, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	handle, err := syscall.CreateFile(name, 0, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", &os.PathError{Op: "open", Path: path, Err: err}
	}
	defer func() { _ = syscall.CloseHandle(handle) }()
	buf := make([]uint16, 512)
	for {
		n, _, callErr := getFinalPathNameByHandleW.Call(uintptr(handle), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), 0) //nolint:gosec // Windows API call
		if n == 0 {
			return "", &os.PathError{Op: "GetFinalPathNameByHandle", Path: path, Err: callErr}
		}
		if int(n) < len(buf) {
			final := syscall.UTF16ToString(buf[:n])
			if strings.HasPrefix(final, `\\?\UNC\`) {
				return `\\` + final[len(`\\?\UNC\`):], nil
			}
			return strings.TrimPrefix(final, `\\?\`), nil
		}
		buf = make([]uint16, n)
	}
}

// makeDirLink creates a junction: it needs no privilege on Windows but takes an absolute target,
// the folder's place in the final version directory.
func makeDirLink(_ string, finalTarget, path string) error {
	if err := os.Mkdir(path, 0o700); err != nil {
		return err
	}
	if err := setJunction(path, filepath.Clean(finalTarget)); err != nil {
		_ = os.Remove(path)
		return err
	}
	return nil
}

func setJunction(path, target string) error {
	substitute := utf16.Encode([]rune(`\??\` + target))
	print := utf16.Encode([]rune(target))
	// PathBuffer: substitute name, NUL, print name, NUL; lengths in bytes without the NUL.
	pathBuffer := make([]uint16, 0, len(substitute)+len(print)+2)
	pathBuffer = append(append(append(append(pathBuffer, substitute...), 0), print...), 0)
	data := make([]byte, 8+2*len(pathBuffer))
	binary.LittleEndian.PutUint16(data[0:], 0)
	binary.LittleEndian.PutUint16(data[2:], uint16(2*len(substitute)))   //nolint:gosec // short path
	binary.LittleEndian.PutUint16(data[4:], uint16(2*len(substitute)+2)) //nolint:gosec // short path
	binary.LittleEndian.PutUint16(data[6:], uint16(2*len(print)))        //nolint:gosec // short path
	for i, unit := range pathBuffer {
		binary.LittleEndian.PutUint16(data[8+2*i:], unit)
	}
	buffer := make([]byte, 8+len(data))
	binary.LittleEndian.PutUint32(buffer[0:], ioReparseTagMountPoint)
	binary.LittleEndian.PutUint16(buffer[4:], uint16(len(data))) //nolint:gosec // short path
	copy(buffer[8:], data)

	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_EXISTING,
		syscall.FILE_FLAG_OPEN_REPARSE_POINT|syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return &os.PathError{Op: "open", Path: path, Err: err}
	}
	defer func() { _ = syscall.CloseHandle(handle) }()
	var returned uint32
	if err := syscall.DeviceIoControl(handle, fsctlSetReparsePoint, &buffer[0], uint32(len(buffer)), nil, 0, &returned, nil); err != nil { //nolint:gosec // short buffer
		return &os.PathError{Op: "junction", Path: path, Err: err}
	}
	return nil
}

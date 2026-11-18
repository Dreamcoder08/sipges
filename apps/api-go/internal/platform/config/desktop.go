package config

import (
	"errors"
	"runtime"
)

// DesktopUpdateDir reads SIPGES_DESKTOP_UPDATE_DIR as parseDesktopUpdateDir of
// apps/api/src/platform/config.ts: the folder shared with the managed desktop launcher. Unset
// returns "" (the cloud and development builds, which never mount the update routes); a set value
// must be an absolute path, as Node's path.isAbsolute reads it.
func DesktopUpdateDir(lookup Lookup) (string, error) {
	value, set := lookup("SIPGES_DESKTOP_UPDATE_DIR")
	if !set {
		return "", nil
	}
	if !nodeIsAbsolute(value, runtime.GOOS == "windows") {
		return "", errors.New("SIPGES_DESKTOP_UPDATE_DIR must be an absolute path")
	}
	return value, nil
}

// nodeIsAbsolute is Node's path.isAbsolute: on Windows a leading slash or backslash, or a drive
// letter followed by one, counts; elsewhere only a leading slash.
func nodeIsAbsolute(p string, windows bool) bool {
	if p == "" {
		return false
	}
	sep := func(c byte) bool { return c == '/' || (windows && c == '\\') }
	if sep(p[0]) {
		return true
	}
	if !windows || len(p) < 3 || p[1] != ':' || !sep(p[2]) {
		return false
	}
	c := p[0] | 0x20
	return c >= 'a' && c <= 'z'
}

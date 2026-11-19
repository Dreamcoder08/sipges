package pglitewasm

import (
	"testing"
)

// On Windows a backslash separates folders and a colon names a drive or a data stream, so a guest
// component like `..\..` would leave the scratch mount once mapped to the host. Such paths are
// refused before they reach the host; on other systems both are ordinary file-name characters.
func TestGuestPathsWithBackslashOrColonNeverLeaveTheMountOnWindows(t *testing.T) {
	root := t.TempDir()
	v := newVFS(nil, "/pgdata", root, nil, nil)
	v.goos = "windows"
	for _, p := range []string{
		`/pgdata/..\..\outside`,
		`/pgdata/base/..\..\..\outside`,
		`/pgdata/a\b`,
		`/pgdata/C:\outside`,
		`/pgdata/C:outside`,
		`/pgdata/PG_VERSION:stream`,
	} {
		if got, e := v.abs(atFDCWD, p); e != eINVAL {
			t.Errorf("abs(%q) = %q, %d; want EINVAL", p, got, e)
		}
		if hp, ok := v.host(p); ok {
			t.Errorf("host(%q) = %q, want refused", p, hp)
		}
	}
	// Relative to a folder of the mount, through a file descriptor or the working folder.
	v.cwd = "/pgdata/base"
	if got, e := v.abs(atFDCWD, `..\..\outside`); e != eINVAL {
		t.Errorf(`abs("..\..\outside") from the mount = %q, %d; want EINVAL`, got, e)
	}
	// Outside the mount nothing maps to the host, so the in-memory tree keeps any name.
	if got, e := v.abs(atFDCWD, `/tmp/a\b:c`); e != 0 || got != `/tmp/a\b:c` {
		t.Errorf("abs of an in-memory path = %q, %d", got, e)
	}
	for _, p := range []string{"/pgdata", "/pgdata/base/1/2", "/pgdata/pg_wal/000000010000000000000001"} {
		if got, e := v.abs(atFDCWD, p); e != 0 || got != p {
			t.Errorf("abs(%q) = %q, %d", p, got, e)
		}
		if _, ok := v.host(p); !ok {
			t.Errorf("host(%q) refused a path of the mount", p)
		}
	}

	v.goos = "linux"
	v.cwd = "/"
	if got, e := v.abs(atFDCWD, `/pgdata/a\b:c`); e != 0 || got != `/pgdata/a\b:c` {
		t.Errorf("linux: abs = %q, %d; want the name kept", got, e)
	}
}

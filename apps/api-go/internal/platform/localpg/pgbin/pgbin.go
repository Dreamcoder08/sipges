// Package pgbin finds PostgreSQL 18 binaries for integration tests. It is imported only by tests.
package pgbin

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// EnvBinDir names the folder holding initdb, pg_ctl and postgres; the desktop command reads it too.
const EnvBinDir = "SIPGES_PG_BIN"

// ForTest returns the binaries folder, from SIPGES_PG_BIN or the folder of pg_ctl on PATH, or
// skips the test with the reason when neither holds PostgreSQL binaries.
func ForTest(t testing.TB) string {
	t.Helper()
	if dir := os.Getenv(EnvBinDir); dir != "" {
		return dir
	}
	path, err := exec.LookPath("pg_ctl")
	if err != nil {
		t.Skipf("PostgreSQL 18 binaries not found: set %s to the folder with initdb, pg_ctl and postgres", EnvBinDir)
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Skipf("PostgreSQL binaries not usable (%v): set %s", err, EnvBinDir)
	}
	return filepath.Dir(resolved)
}

// FailingStop returns a binaries folder that runs the real ones in realBin, except that
// `pg_ctl stop` fails while the file failStop exists, so a test can make a stop fail on demand.
// It needs a POSIX shell, so it skips the test on Windows.
func FailingStop(t testing.TB, realBin, failStop string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the failing pg_ctl is a shell script")
	}
	dir := t.TempDir()
	for _, name := range []string{"initdb", "postgres"} {
		if err := os.Symlink(filepath.Join(realBin, name), filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	script := "#!/bin/sh\n" +
		"if [ \"$1\" = stop ] && [ -e " + quote(failStop) + " ]; then echo 'synthetic stop failure' >&2; exit 1; fi\n" +
		"exec " + quote(filepath.Join(realBin, "pg_ctl")) + " \"$@\"\n"
	if err := os.WriteFile(filepath.Join(dir, "pg_ctl"), []byte(script), 0o700); err != nil { //nolint:gosec // G306: an executable test script
		t.Fatal(err)
	}
	return dir
}

// quote makes path one single-quoted shell word.
func quote(path string) string { return "'" + strings.ReplaceAll(path, "'", `'\''`) + "'" }

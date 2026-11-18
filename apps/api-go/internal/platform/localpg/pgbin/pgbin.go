// Package pgbin finds PostgreSQL 18 binaries for integration tests. It is imported only by tests.
package pgbin

import (
	"os"
	"os/exec"
	"path/filepath"
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

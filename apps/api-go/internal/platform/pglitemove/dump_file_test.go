//go:build !windows

package pglitemove

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// pg_dump writes a plain dump to stdout in text mode on Windows (LF becomes CRLF), which would
// break the \restrict match and change multi-line values: the dump is written with -f instead.
func TestPgDumpReadsTheDumpFromItsFileNotStdout(t *testing.T) {
	dir := t.TempDir()
	fake := filepath.Join(dir, "pg_dump")
	script := "#!/bin/sh\nout=\nwhile [ $# -gt 0 ]; do [ \"$1\" = -f ] && out=$2; shift; done\n" +
		"echo 'stdout is not the dump'\n" +
		"[ -n \"$out\" ] && printf '%s\\n' '\\restrict k1' 'CREATE TABLE t (a int);' '\\unrestrict k1' > \"$out\"\n"
	if err := os.WriteFile(fake, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "dump.sql")
	dump, err := pgDump(context.Background(), fake, "postgres://x", file)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(dump) != "CREATE TABLE t (a int);" {
		t.Fatalf("dump %q", dump)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("the dump file was left behind: %v", err)
	}
}

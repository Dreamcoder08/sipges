package localpg

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// pg_ctl's own output never goes to the server log it passes with -l: on Windows pg_ctl starts the
// server through cmd's ">> logfile", which cannot open a file this process holds open for writing
// ("The process cannot access the file because it is being used by another process", go-mode
// rehearsal run 44266330106).
func TestPgCtlOutputGoesToItsOwnLogNotTheServerLog(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a shell script as a stand-in pg_ctl")
	}
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "pg_ctl"), []byte("#!/bin/sh\necho pg_ctl said this\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(t.TempDir(), "pg18.log")
	s := &Server{opts: Options{BinDir: bin, LogPath: logPath}}
	if err := s.pgctl(context.Background(), []string{"status"}); err != nil {
		t.Fatalf("pgctl: %v", err)
	}
	if b, err := os.ReadFile(logPath); err == nil && len(b) > 0 {
		t.Fatalf("pg_ctl output went to the server log: %q", b)
	}
	got, err := os.ReadFile(ctlLogPath(logPath))
	if err != nil || !strings.Contains(string(got), "pg_ctl said this") {
		t.Fatalf("pg_ctl log %s = %q, %v", ctlLogPath(logPath), got, err)
	}
	if ctlLogPath(logPath) == logPath || filepath.Dir(ctlLogPath(logPath)) != filepath.Dir(logPath) {
		t.Fatalf("ctlLogPath(%s) = %s, want another file next to it", logPath, ctlLogPath(logPath))
	}
}

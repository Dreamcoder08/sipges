//go:build windows

package localpg

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// imageNamed starts a copy of this test binary named name, sleeping, and returns its process id.
func imageNamed(t *testing.T, name string) int {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(t.TempDir(), name)
	in, err := os.Open(self)
	if err != nil {
		t.Fatal(err)
	}
	out, err := os.Create(dst)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		t.Fatal(err)
	}
	_ = in.Close()
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(dst)
	cmd.Env = append(os.Environ(), sleeperEnv+"=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return cmd.Process.Pid
}

// Rules 2 and 5 on Windows: a live postgres.exe serves the folder even when its port is closed;
// another program never does, even when the port answers like PostgreSQL.
func TestServingOnWindowsFollowsTheProcessImage(t *testing.T) {
	postgres := imageNamed(t, "postgres.exe")
	if got := identify(postgres, t.TempDir()); got != identityPostgres {
		t.Fatalf("identify(postgres.exe) = %v", got)
	}
	if got := identify(os.Getpid(), t.TempDir()); got != identityOther {
		t.Fatalf("identify(test binary) = %v", got)
	}
	if _, serving := Serving(context.Background(), pidFileFor(t, postgres, refusedPort(t))); !serving {
		t.Fatal("Serving: a live postgres.exe does not count")
	}
	other := imageNamed(t, "other.exe")
	if _, serving := Serving(context.Background(), pidFileFor(t, other, listener(t, []byte{'N'}))); serving {
		t.Fatal("Serving: another program counts")
	}
}

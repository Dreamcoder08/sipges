package localpg

import (
	"context"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// listener answers every connection with reply after reading the 8-byte SSLRequest; a nil reply
// accepts the connection and never answers, as a frozen or slow server does.
func listener(t *testing.T, reply []byte) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	t.Cleanup(func() { close(done); _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = conn.Close() }()
				if _, err := io.ReadFull(conn, make([]byte, 8)); err != nil {
					return
				}
				if reply == nil {
					<-done
					return
				}
				_, _ = conn.Write(reply)
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func refusedPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

// withIdentity makes Serving see id for every process, as on a system that does not tell.
func withIdentity(t *testing.T, id identity) {
	t.Helper()
	saved, savedTimeout := processIdentity, probeTimeout
	processIdentity = func(int, string) identity { return id }
	probeTimeout = 300 * time.Millisecond
	t.Cleanup(func() { processIdentity, probeTimeout = saved, savedTimeout })
}

func pidFileFor(t *testing.T, pid, port int) string {
	t.Helper()
	dataDir := t.TempDir()
	body := strconv.Itoa(pid) + "\n" + dataDir + "\n1700000000\n" + strconv.Itoa(port) + "\n\n127.0.0.1\n  0  0\nready   \n"
	if err := os.WriteFile(filepath.Join(dataDir, "postmaster.pid"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return dataDir
}

// Rule 3: when the process cannot be identified, only a refused connection or a reply that is not
// PostgreSQL's frees the folder; silence, a timeout or an unusable port count as serving.
func TestServingWithAnUnidentifiedProcessRefusesUnlessThePortProvesItFree(t *testing.T) {
	withIdentity(t, identityUnknown)
	live := os.Getpid()
	for _, c := range []struct {
		name    string
		port    func(*testing.T) int
		serving bool
	}{
		{"answers N", func(t *testing.T) int { return listener(t, []byte{'N'}) }, true},
		{"accepts and stays silent", func(t *testing.T) int { return listener(t, nil) }, true},
		{"no usable port", func(*testing.T) int { return 0 }, true},
		{"refuses the connection", refusedPort, false},
		{"answers something else", func(t *testing.T) int { return listener(t, []byte{'X'}) }, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			dataDir := pidFileFor(t, live, c.port(t))
			if _, serving := Serving(context.Background(), dataDir); serving != c.serving {
				t.Fatalf("Serving = %v, want %v", serving, c.serving)
			}
		})
	}
}

// Rules 1, 2 and 4: a live process proven to be PostgreSQL on the folder serves it, listening or
// not. Rule 5: one proven to be another program never does, whatever its port says.
func TestServingFollowsTheProcessIdentityBeforeThePort(t *testing.T) {
	live := os.Getpid()
	t.Run("PostgreSQL on the folder, port refused", func(t *testing.T) {
		withIdentity(t, identityPostgres)
		if _, serving := Serving(context.Background(), pidFileFor(t, live, refusedPort(t))); !serving {
			t.Fatal("Serving: PostgreSQL proven on the folder does not count")
		}
	})
	t.Run("another program, port answers N", func(t *testing.T) {
		withIdentity(t, identityOther)
		if _, serving := Serving(context.Background(), pidFileFor(t, live, listener(t, []byte{'N'}))); serving {
			t.Fatal("Serving: a program proven not to be PostgreSQL counts")
		}
	})
	t.Run("dead process, port answers N", func(t *testing.T) {
		withIdentity(t, identityPostgres)
		if _, serving := Serving(context.Background(), pidFileFor(t, 2147483646, listener(t, []byte{'N'}))); serving {
			t.Fatal("Serving: a dead process counts")
		}
	})
}

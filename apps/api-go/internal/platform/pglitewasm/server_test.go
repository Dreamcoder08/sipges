package pglitewasm

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/localpg"
)

// openServed boots the backend on a scratch copy of the synthetic folder and serves it on loopback.
func openServed(t *testing.T) (*Server, string, string) {
	t.Helper()
	dist := distDir(t)
	source := syntheticDataDir(t)
	before := hashTree(t, source)
	scratch := filepath.Join(t.TempDir(), "pgdata")
	copyTree(t, source, scratch)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	t.Cleanup(cancel)
	backend, err := Open(ctx, dist, scratch)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	srv, err := Serve(ctx, backend)
	if err != nil {
		_ = backend.Close(ctx)
		t.Fatalf("Serve: %v", err)
	}
	t.Cleanup(func() {
		if err := srv.Close(); err != nil {
			t.Errorf("server Close: %v", err)
		}
		if err := backend.Close(context.Background()); err != nil {
			t.Errorf("backend Close: %v", err)
		}
	})
	return srv, source, before
}

// pgliteURL leaves sslmode at its default (prefer), so clients first send SSLRequest and must
// fall back on the server's 'N'.
func pgliteURL(srv *Server) string {
	return fmt.Sprintf("postgres://postgres@%s/postgres", srv.Addr())
}

func TestServerAnswersPgxAndRefusesASecondConnection(t *testing.T) {
	srv, source, before := openServed(t)
	if host := srv.Addr().IP.String(); host != "127.0.0.1" {
		t.Fatalf("listens on %s, want 127.0.0.1 only", host)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	conn, err := pgx.Connect(ctx, pgliteURL(srv))
	if err != nil {
		t.Fatalf("pgx connect: %v", err)
	}
	var count int64
	var sum float64
	if err := conn.QueryRow(ctx, "select count(*), sum(x) from t").Scan(&count, &sum); err != nil {
		t.Fatalf("query: %v", err)
	}
	if count != 2000 || sum != 3001500 {
		t.Fatalf("count/sum = %d/%v, want 2000/3001500", count, sum)
	}

	second, err := pgx.Connect(ctx, pgliteURL(srv))
	if err == nil {
		_ = second.Close(ctx)
		t.Fatal("a second simultaneous connection was accepted")
	}
	if !strings.Contains(err.Error(), "one connection at a time") {
		t.Fatalf("second connection error = %v, want a clear one-connection error", err)
	}
	// The first connection is still served.
	if err := conn.QueryRow(ctx, "select count(*) from t").Scan(&count); err != nil || count != 2000 {
		t.Fatalf("first connection after refusal: %v %d", err, count)
	}
	if err := conn.Close(ctx); err != nil {
		t.Fatalf("close: %v", err)
	}

	// Once the first one leaves, a new connection gets a clean session (pgx reuses statement names).
	again, err := pgx.Connect(ctx, pgliteURL(srv))
	if err != nil {
		t.Fatalf("reconnect: %v", err)
	}
	if err := again.QueryRow(ctx, "select count(*), sum(x) from t").Scan(&count, &sum); err != nil || count != 2000 {
		t.Fatalf("reconnected query: %v %d", err, count)
	}
	_ = again.Close(ctx)

	if after := hashTree(t, source); after != before {
		t.Errorf("source folder changed: %s -> %s", before, after)
	}
}

func TestNativePgDumpRestoresIntoPostgres18(t *testing.T) {
	pgDump, err := exec.LookPath("pg_dump")
	if err != nil {
		t.Skip("pg_dump is not on PATH")
	}
	binDir := filepath.Dir(pgDump)
	psql := filepath.Join(binDir, "psql")
	for _, name := range []string{"psql", "initdb", "pg_ctl", "postgres"} {
		if _, err := os.Stat(filepath.Join(binDir, name)); err != nil {
			t.Skipf("%s is not next to pg_dump", name)
		}
	}
	if out, err := exec.Command(pgDump, "--version").Output(); err != nil || !strings.Contains(string(out), " 18.") {
		t.Skipf("pg_dump is not PostgreSQL 18: %s", out)
	}
	srv, source, before := openServed(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	work := t.TempDir()
	for _, mode := range []struct {
		name string
		args []string
		data string // how the rows of t appear in the dump
	}{
		{"copy", nil, "COPY public.t "},
		{"inserts", []string{"--inserts"}, "INSERT INTO public.t VALUES"},
	} {
		t.Run(mode.name, func(t *testing.T) {
			dump := filepath.Join(work, mode.name+".sql")
			args := append([]string{"--no-owner", "--file", dump, "--dbname", pgliteURL(srv)}, mode.args...)
			cmd := exec.CommandContext(ctx, pgDump, args...)
			cmd.Env = append(os.Environ(), "PGCONNECT_TIMEOUT=30")
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("pg_dump %s: %v\n%s", mode.name, err, out)
			}
			if text, err := os.ReadFile(dump); err != nil || !strings.Contains(string(text), mode.data) {
				t.Fatalf("dump %s lacks %q: %v", mode.name, mode.data, err)
			}

			pg, err := localpg.Start(ctx, localpg.Options{
				BinDir:        binDir,
				DataDir:       filepath.Join(work, mode.name+"-pg18"),
				LogPath:       filepath.Join(work, mode.name+"-pg18.log"),
				SuperUser:     "postgres",
				SuperPassword: "synthetic-test-only",
			})
			if err != nil {
				t.Fatalf("start PostgreSQL 18: %v", err)
			}
			defer func() {
				if err := pg.Stop(context.WithoutCancel(ctx)); err != nil {
					t.Errorf("stop PostgreSQL 18: %v", err)
				}
			}()
			restore := exec.CommandContext(ctx, psql, "--no-psqlrc", "--quiet", "--single-transaction",
				"-v", "ON_ERROR_STOP=1", "--file", dump, "--dbname", pg.SuperUserURL("postgres"))
			if out, err := restore.CombinedOutput(); err != nil {
				t.Fatalf("restore %s: %v\n%s", mode.name, err, out)
			}

			conn, err := pgx.Connect(ctx, pg.SuperUserURL("postgres"))
			if err != nil {
				t.Fatalf("connect restored: %v", err)
			}
			defer func() { _ = conn.Close(context.WithoutCancel(ctx)) }()
			var count int64
			var sum float64
			if err := conn.QueryRow(ctx, "select count(*), sum(x) from t").Scan(&count, &sum); err != nil {
				t.Fatalf("restored query: %v", err)
			}
			if count != 2000 || sum != 3001500 {
				t.Fatalf("restored count/sum = %d/%v, want 2000/3001500", count, sum)
			}
			var one int
			if err := conn.QueryRow(ctx, "select f()").Scan(&one); err != nil || one != 1 {
				t.Fatalf("restored f(): %v %d", err, one)
			}
		})
	}
	if after := hashTree(t, source); after != before {
		t.Errorf("source folder changed: %s -> %s", before, after)
	}
}

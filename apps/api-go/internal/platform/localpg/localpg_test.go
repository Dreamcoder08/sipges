package localpg

import (
	"context"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestInitdbArgsUseThePinnedLocaleAndALocalSuperuser(t *testing.T) {
	got := initdbArgs("/data/pg18", "postgres", "/tmp/pw")
	want := []string{
		"-D", "/data/pg18",
		"--locale-provider=builtin", "--locale=C.UTF-8", "-E", "UTF8",
		"-U", "postgres", "--auth=scram-sha-256", "--pwfile=/tmp/pw",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("initdb args\n got %q\nwant %q", got, want)
	}
}

func TestStartArgsListenOnLoopbackOnlyOnTheChosenPort(t *testing.T) {
	got := startArgs("/data/pg18", "/state/pg18.log", 54321, 60)
	want := []string{
		"start", "-D", "/data/pg18", "-l", "/state/pg18.log", "-w", "-t", "60",
		"-o", "-p 54321 -c listen_addresses=127.0.0.1 -c unix_socket_directories=",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("pg_ctl start args\n got %q\nwant %q", got, want)
	}
}

func TestStopArgsUseFastShutdown(t *testing.T) {
	got := stopArgs("/data/pg18", 30)
	want := []string{"stop", "-D", "/data/pg18", "-m", "fast", "-w", "-t", "30"}
	if !slices.Equal(got, want) {
		t.Fatalf("pg_ctl stop args\n got %q\nwant %q", got, want)
	}
}

func TestInspectDataDir(t *testing.T) {
	root := t.TempDir()
	missing := filepath.Join(root, "missing")
	empty := filepath.Join(root, "empty")
	pg18 := filepath.Join(root, "pg18")
	for _, dir := range []string{empty, pg18} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	writeFile(t, filepath.Join(pg18, "PG_VERSION"), "18\n")

	for name, tc := range map[string]struct {
		dir  string
		want dataState
	}{
		"missing folder": {missing, dataEmpty},
		"empty folder":   {empty, dataEmpty},
		"PostgreSQL 18":  {pg18, dataCluster},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := inspectDataDir(tc.dir)
			if err != nil || got != tc.want {
				t.Fatalf("inspectDataDir = %v, %v; want %v", got, err, tc.want)
			}
		})
	}
}

func TestStartRefusesAForeignNonEmptyFolderWithoutTouchingIt(t *testing.T) {
	for name, files := range map[string]map[string]string{
		"no PG_VERSION":        {"notes.txt": "synthetic notes"},
		"another major":        {"PG_VERSION": "17\n", "notes.txt": "synthetic notes"},
		"a PGlite-like folder": {"base.tar": "synthetic", "PG_VERSION.bak": "18"},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			for file, body := range files {
				writeFile(t, filepath.Join(dir, file), body)
			}
			before := snapshot(t, dir)
			// No binaries are needed: the folder is refused before any program runs.
			_, err := Start(context.Background(), Options{
				BinDir: t.TempDir(), DataDir: dir, LogPath: filepath.Join(t.TempDir(), "pg.log"),
				SuperPassword: "synthetic",
			})
			if !errors.Is(err, ErrForeignDataDir) {
				t.Fatalf("Start = %v, want ErrForeignDataDir", err)
			}
			if msg := UserMessage(err); !strings.Contains(msg, "no es una base de datos de SIPGES") {
				t.Fatalf("user message %q is not the Spanish one", msg)
			}
			if after := snapshot(t, dir); !maps.Equal(before, after) {
				t.Fatalf("folder changed: before %v after %v", before, after)
			}
		})
	}
}

func TestStartReportsMissingBinaries(t *testing.T) {
	_, err := Start(context.Background(), Options{
		BinDir: t.TempDir(), DataDir: t.TempDir(), LogPath: filepath.Join(t.TempDir(), "pg.log"),
		SuperPassword: "synthetic",
	})
	if !errors.Is(err, ErrBinariesMissing) {
		t.Fatalf("Start = %v, want ErrBinariesMissing", err)
	}
	if msg := UserMessage(err); !strings.Contains(msg, "No se encontraron los ejecutables de PostgreSQL") {
		t.Fatalf("user message %q is not the Spanish one", msg)
	}
}

func TestMajorVersionReadsPostgresVersionOutput(t *testing.T) {
	for out, want := range map[string]int{
		"postgres (PostgreSQL) 18.7\n":          18,
		"postgres (PostgreSQL) 18.1 (EDB)\r\n":  18,
		"postgres (PostgreSQL) 17.6\n":          17,
		"postgres (PostgreSQL) 19devel\n":       19,
		"something else entirely\n":             0,
		"postgres (PostgreSQL) not-a-version\n": 0,
	} {
		if got := majorVersion(out); got != want {
			t.Errorf("majorVersion(%q) = %d, want %d", out, got, want)
		}
	}
}

func TestURLEscapesCredentials(t *testing.T) {
	s := &Server{port: 54321}
	got := s.URL("sipges_app", "p@ss/word", "sipges")
	want := "postgres://sipges_app:p%40ss%2Fword@127.0.0.1:54321/sipges?sslmode=disable"
	if got != want {
		t.Fatalf("URL = %q, want %q", got, want)
	}
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func snapshot(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		body, err := os.ReadFile(path)
		out[path] = string(body)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

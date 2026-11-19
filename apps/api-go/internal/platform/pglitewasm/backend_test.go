package pglitewasm

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// distDir returns the folder holding the pinned @electric-sql/pglite 0.5.15 dist files
// (pglite.wasm, pglite.data, pglite.js). The large files are not committed.
func distDir(t *testing.T) string {
	t.Helper()
	dir := os.Getenv("SIPGES_PGLITE_DIST")
	if dir == "" {
		t.Skip("SIPGES_PGLITE_DIST is not set: point it at the dist folder of @electric-sql/pglite 0.5.15")
	}
	return dir
}

// syntheticDataDir returns a synthetic data folder made by PGlite 0.5.15 itself: table t with
// 2000 rows (id int, x float8, s text, d timestamptz) and a plpgsql function f().
func syntheticDataDir(t *testing.T) string {
	t.Helper()
	dir := os.Getenv("SIPGES_PGLITE_PGDATA")
	if dir == "" {
		t.Skip("SIPGES_PGLITE_PGDATA is not set: point it at a synthetic PGlite 0.5.15 data folder")
	}
	return dir
}

func TestBackendAnswersSelectOnScratchCopy(t *testing.T) {
	dist := distDir(t)
	source := syntheticDataDir(t)
	before := hashTree(t, source)

	scratch := filepath.Join(t.TempDir(), "pgdata")
	copyTree(t, source, scratch)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	backend, err := Open(ctx, dist, scratch)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() {
		if err := backend.Close(ctx); err != nil {
			t.Errorf("Close: %v", err)
		}
	}()

	result, err := backend.SimpleQuery(ctx, "select count(*), sum(x) from t")
	if err != nil {
		t.Fatalf("SimpleQuery: %v\nbackend log:\n%s", err, backend.Log())
	}
	if len(result.Rows) != 1 || len(result.Rows[0]) != 2 {
		t.Fatalf("rows = %q, want one row of two columns", result.Rows)
	}
	if got := result.Rows[0][0]; got != "2000" {
		t.Errorf("count = %q, want 2000", got)
	}
	if got := result.Rows[0][1]; got != "3001500" {
		t.Errorf("sum = %q, want 3001500", got)
	}

	if after := hashTree(t, source); after != before {
		t.Errorf("source folder changed: %s -> %s", before, after)
	}
}

func TestBackendReportsSQLErrorAndKeepsServing(t *testing.T) {
	dist := distDir(t)
	source := syntheticDataDir(t)
	scratch := filepath.Join(t.TempDir(), "pgdata")
	copyTree(t, source, scratch)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	backend, err := Open(ctx, dist, scratch)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = backend.Close(ctx) }()

	result, err := backend.SimpleQuery(ctx, "select * from missing_table")
	if err != nil {
		t.Fatalf("SimpleQuery transport error: %v\n%s", err, backend.Log())
	}
	if result.Error == "" {
		t.Fatalf("want a SQL error for a missing table, got rows %q", result.Rows)
	}

	// Reading the catalog of a plpgsql function (what pg_dump does) needs no side module.
	result, err = backend.SimpleQuery(ctx, "select count(*), length(pg_get_functiondef('f'::regproc)) > 0 from pg_proc where proname = 'f'")
	if err != nil {
		t.Fatalf("SimpleQuery after error: %v\n%s", err, backend.Log())
	}
	if result.Error != "" || len(result.Rows) != 1 || result.Rows[0][0] != "1" || result.Rows[0][1] != "t" {
		t.Fatalf("catalog read: error %q rows %q", result.Error, result.Rows)
	}
	if loads := backend.DynamicLoads(); len(loads) != 0 {
		t.Fatalf("catalog read loaded side modules: %q", loads)
	}
}

func TestBackendRefusesSideModulesExplicitly(t *testing.T) {
	dist := distDir(t)
	source := syntheticDataDir(t)
	scratch := filepath.Join(t.TempDir(), "pgdata")
	copyTree(t, source, scratch)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	backend, err := Open(ctx, dist, scratch)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = backend.Close(ctx) }()

	// Executing plpgsql needs dlopen of plpgsql.so, which this host does not link.
	result, err := backend.SimpleQuery(ctx, "select f()")
	if err != nil {
		t.Fatalf("SimpleQuery: %v\n%s", err, backend.Log())
	}
	if !strings.Contains(result.Error, "plpgsql.so") {
		t.Fatalf("select f(): error %q rows %q, want a could-not-load error for plpgsql.so", result.Error, result.Rows)
	}
	if loads := backend.DynamicLoads(); len(loads) != 1 || !strings.Contains(loads[0], "plpgsql") {
		t.Fatalf("dynamic loads = %q, want plpgsql only", loads)
	}
	result, err = backend.SimpleQuery(ctx, "select 1")
	if err != nil || result.Error != "" || len(result.Rows) != 1 || result.Rows[0][0] != "1" {
		t.Fatalf("select 1 after refused load: %v %+v", err, result)
	}
}

func hashTree(t *testing.T, root string) string {
	t.Helper()
	var paths []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			paths = append(paths, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	sort.Strings(paths)
	h := sha256.New()
	for _, p := range paths {
		rel, _ := filepath.Rel(root, p)
		_, _ = io.WriteString(h, rel+"\x00")
		f, err := os.Open(p)
		if err != nil {
			t.Fatalf("open %s: %v", p, err)
		}
		if _, err := io.Copy(h, f); err != nil {
			t.Fatalf("read %s: %v", p, err)
		}
		_ = f.Close()
	}
	return hex.EncodeToString(h.Sum(nil))
}

func copyTree(t *testing.T, src, dst string) {
	t.Helper()
	err := filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o600)
	})
	if err != nil {
		t.Fatalf("copy %s: %v", src, err)
	}
}

func TestBackendAcceptsStartupAndExtendedProtocol(t *testing.T) {
	dist := distDir(t)
	source := syntheticDataDir(t)
	scratch := filepath.Join(t.TempDir(), "pgdata")
	copyTree(t, source, scratch)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	backend, err := Open(ctx, dist, scratch)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = backend.Close(ctx) }()

	// StartupMessage, protocol 3.0, as a client such as pg_dump sends it.
	body := []byte{0, 3, 0, 0}
	for _, kv := range []string{"user", "postgres", "database", "postgres"} {
		body = append(append(body, kv...), 0)
	}
	body = append(body, 0)
	startup := append(binary.BigEndian.AppendUint32(nil, uint32(len(body)+4)), body...)
	out, err := backend.Exchange(ctx, startup)
	if err != nil {
		t.Fatalf("startup: %v\n%s", err, backend.Log())
	}
	types := messageTypes(t, out)
	if !strings.HasPrefix(types, "R") || !strings.HasSuffix(types, "Z") || !strings.Contains(types, "S") {
		t.Fatalf("startup reply types = %q, want AuthenticationOk ... ParameterStatus ... ReadyForQuery", types)
	}

	// Parse / Bind / Describe / Execute / Sync with one text parameter.
	var msg []byte
	add := func(typ byte, payload []byte) {
		msg = append(msg, typ)
		msg = binary.BigEndian.AppendUint32(msg, uint32(len(payload)+4))
		msg = append(msg, payload...)
	}
	add('P', append([]byte("\x00select count(*) from t where id <= $1::int\x00"), 0, 0))
	bind := []byte("\x00\x00")
	bind = append(bind, 0, 0, 0, 1)
	bind = binary.BigEndian.AppendUint32(bind, 2)
	bind = append(bind, "10"...)
	bind = append(bind, 0, 0)
	add('B', bind)
	add('D', []byte("P\x00"))
	add('E', []byte("\x00\x00\x00\x00\x00"))
	add('S', nil)
	out, err = backend.Exchange(ctx, msg)
	if err != nil {
		t.Fatalf("extended: %v\n%s", err, backend.Log())
	}
	// ParameterStatus ('S') may arrive at any time; PGlite reports GUCs after the first command.
	if types := strings.ReplaceAll(messageTypes(t, out), "S", ""); types != "12TDCZ" {
		t.Fatalf("extended reply types = %q, want 12TDCZ apart from ParameterStatus", types)
	}
	result, err := decodeSimple(out)
	if err != nil || len(result.Rows) != 1 || result.Rows[0][0] != "10" {
		t.Fatalf("extended result: %v %+v", err, result)
	}
}

func messageTypes(t *testing.T, out []byte) string {
	t.Helper()
	var types []byte
	for len(out) >= 5 {
		n := int(binary.BigEndian.Uint32(out[1:5]))
		if len(out) < 1+n {
			t.Fatalf("truncated message %q", out[0])
		}
		types = append(types, out[0])
		out = out[1+n:]
	}
	return string(types)
}

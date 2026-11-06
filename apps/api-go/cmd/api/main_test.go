package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// syncBuffer is a bytes.Buffer safe for the server goroutine and the test.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func lookup(values map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := values[k]; return v, ok }
}

func TestRunRefusesInvalidConfiguration(t *testing.T) {
	t.Parallel()
	var out syncBuffer
	err := run(context.Background(), lookup(map[string]string{"SIPGES_DATABASE_URL": "postgres://u:synthetic-secret@h/db", "SIPGES_PORT": "x"}), &out, net.Listen)
	if err == nil || !strings.Contains(err.Error(), "SIPGES_PORT") || strings.Contains(err.Error()+out.String(), "synthetic-secret") {
		t.Fatalf("err = %v, out = %s", err, out.String())
	}
}

func TestRunServesHealthAndStopsOnCancel(t *testing.T) {
	t.Parallel()
	addrs := make(chan string, 1)
	listen := func(network, _ string) (net.Listener, error) {
		ln, err := net.Listen(network, "127.0.0.1:0")
		if err == nil {
			addrs <- ln.Addr().String()
		}
		return ln, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	var out syncBuffer
	done := make(chan error, 1)
	// The pool is lazy: an unreachable synthetic database only makes readiness fail.
	go func() {
		done <- run(ctx, lookup(map[string]string{"SIPGES_DATABASE_URL": "postgres://u:synthetic-secret@127.0.0.1:1/db?connect_timeout=1"}), &out, listen)
	}()
	addr := <-addrs
	get := func(path string) (int, string) {
		resp, err := http.Get("http://" + addr + path)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, strings.TrimSpace(string(body))
	}
	if status, body := get("/health"); status != 200 || body != `{"status":"ok","service":"SIPGES","version":"V0.5.1"}` {
		t.Fatalf("/health = %d %s", status, body)
	}
	if status, body := get("/health/ready"); status != 503 || body != `{"status":"unavailable"}` {
		t.Fatalf("/health/ready = %d %s", status, body)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run = %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("run did not stop")
	}
	logs := out.String()
	if strings.Contains(logs, "synthetic-secret") {
		t.Fatalf("secret in logs: %s", logs)
	}
	for _, want := range []string{`"msg":"listening"`, `"msg":"request"`, `"msg":"stopped"`} {
		if !strings.Contains(logs, want) {
			t.Fatalf("logs lack %s: %s", want, logs)
		}
	}
}

func TestRunRefusesAPrivilegedLoginBeforeListening(t *testing.T) {
	s := scratchDB(t)
	listened := false
	listen := func(network, address string) (net.Listener, error) {
		listened = true
		return net.Listen(network, address)
	}
	var out syncBuffer
	err := run(context.Background(), lookup(map[string]string{"SIPGES_DATABASE_URL": s.URL}), &out, listen)
	if !errors.Is(err, database.ErrPrivilegedRole) {
		t.Fatalf("got %v", err)
	}
	if listened {
		t.Fatal("the API listened on a login that bypasses row-level security")
	}
}

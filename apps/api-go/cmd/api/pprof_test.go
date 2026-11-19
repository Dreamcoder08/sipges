package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestPprofAddressIsOffByDefault(t *testing.T) {
	t.Parallel()
	for _, values := range []map[string]string{{}, {pprofEnv: ""}} {
		addr, err := pprofAddress(lookup(values))
		if addr != "" || err != nil {
			t.Fatalf("%v: addr = %q, err = %v", values, addr, err)
		}
	}
}

func TestPprofAddressAcceptsOnlyLoopback(t *testing.T) {
	t.Parallel()
	for _, addr := range []string{"127.0.0.1:6061", "[::1]:6061", "127.0.0.2:0"} {
		got, err := pprofAddress(lookup(map[string]string{pprofEnv: addr}))
		if got != addr || err != nil {
			t.Errorf("%q: got %q, err = %v", addr, got, err)
		}
	}
	for _, addr := range []string{":6061", "0.0.0.0:6061", "[::]:6061", "192.0.2.1:6061", "example.com:6061", "localhost:6061", "127.0.0.1", "127.0.0.1:"} {
		if _, err := pprofAddress(lookup(map[string]string{pprofEnv: addr})); !errors.Is(err, errPprofAddr) {
			t.Errorf("%q: err = %v, want errPprofAddr", addr, err)
		}
	}
}

func TestRunRefusesAPublicPprofAddress(t *testing.T) {
	t.Parallel()
	err := run(context.Background(), lookup(map[string]string{
		"SIPGES_DATABASE_URL": "postgres://u@h/db", pprofEnv: "0.0.0.0:6061",
	}), io.Discard, func(string, string) (net.Listener, error) {
		t.Fatal("nothing may listen")
		return nil, nil
	})
	if !errors.Is(err, errPprofAddr) {
		t.Fatalf("err = %v", err)
	}
}

// loopbackListen listens on a free loopback port and reports the address.
func loopbackListen(addrs chan<- string) listenFunc {
	return func(network, _ string) (net.Listener, error) {
		ln, err := net.Listen(network, "127.0.0.1:0")
		if err == nil {
			addrs <- ln.Addr().String()
		}
		return ln, err
	}
}

// pprofAnswers reports whether the profiles answer at addr, on a fresh connection.
func pprofAnswers(addr string) bool {
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: time.Second}
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://"+addr+"/debug/pprof/cmdline", nil)
	res, err := client.Do(req)
	if err != nil {
		return false
	}
	_ = res.Body.Close()
	return res.StatusCode == http.StatusOK
}

// eventually waits for cond, polling, so a server stopping on another goroutine has time to
// stop even on one CPU.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("still %s after 10 s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestStartPprofServesProfilesUntilCancel(t *testing.T) {
	t.Parallel()
	if stop, err := startPprof(context.Background(), "", nil, nil); err != nil || stop == nil {
		t.Fatalf("empty address: %v", err)
	}
	addrs := make(chan string, 1)
	ctx, cancel := context.WithCancel(context.Background())
	if _, err := startPprof(ctx, "127.0.0.1:0", loopbackListen(addrs), slog.New(slog.DiscardHandler)); err != nil {
		t.Fatal(err)
	}
	addr := <-addrs
	if !pprofAnswers(addr) {
		t.Fatal("profiles do not answer")
	}
	cancel()
	eventually(t, "answering after cancel", func() bool { return !pprofAnswers(addr) })
}

func TestStartPprofStopsWhenAsked(t *testing.T) {
	t.Parallel()
	addrs := make(chan string, 1)
	stop, err := startPprof(context.Background(), "127.0.0.1:0", loopbackListen(addrs), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	addr := <-addrs
	stop()
	stop() // twice is harmless
	eventually(t, "answering after stop", func() bool { return !pprofAnswers(addr) })
}

func TestRunStopsPprofWhenStartupFails(t *testing.T) {
	t.Parallel()
	addrs := make(chan string, 1)
	pprofListen := loopbackListen(addrs)
	calls := 0
	// The profiles listen first; the API's own listen then fails, so run returns an error while
	// its context is still alive: only run itself can stop the profiles.
	listen := func(network, address string) (net.Listener, error) {
		calls++
		if calls == 1 {
			return pprofListen(network, address)
		}
		return nil, errors.New("synthetic listen failure")
	}
	err := run(context.Background(), lookup(map[string]string{
		"SIPGES_DATABASE_URL": "postgres://synthetic@127.0.0.1:1/db", pprofEnv: "127.0.0.1:0",
	}), io.Discard, listen)
	if err == nil || !strings.Contains(err.Error(), "synthetic listen failure") {
		t.Fatalf("err = %v", err)
	}
	addr := <-addrs
	eventually(t, "answering after run failed", func() bool { return !pprofAnswers(addr) })
}

// failingListener accepts nothing: its first Accept fails with a permanent error.
type failingListener struct{ net.Listener }

func (failingListener) Accept() (net.Conn, error) { return nil, errors.New("synthetic accept failure") }

func TestStartPprofLogsAnUnexpectedServerError(t *testing.T) {
	t.Parallel()
	var out syncBuffer
	log := slog.New(slog.NewJSONHandler(&out, nil))
	listen := func(network, _ string) (net.Listener, error) {
		ln, err := net.Listen(network, "127.0.0.1:0")
		return failingListener{ln}, err
	}
	stop, err := startPprof(context.Background(), "127.0.0.1:0", listen, log)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	eventually(t, "without a pprof_failed log", func() bool {
		return strings.Contains(out.String(), `"msg":"pprof_failed"`) && strings.Contains(out.String(), "synthetic accept failure")
	})
}

func TestStartPprofLogsNothingOnShutdown(t *testing.T) {
	t.Parallel()
	var out syncBuffer
	log := slog.New(slog.NewJSONHandler(&out, nil))
	addrs := make(chan string, 1)
	stop, err := startPprof(context.Background(), "127.0.0.1:0", loopbackListen(addrs), log)
	if err != nil {
		t.Fatal(err)
	}
	addr := <-addrs
	stop()
	eventually(t, "answering after stop", func() bool { return !pprofAnswers(addr) })
	time.Sleep(50 * time.Millisecond)
	if strings.Contains(out.String(), "pprof_failed") {
		t.Fatalf("a normal shutdown logged a failure: %s", out.String())
	}
}

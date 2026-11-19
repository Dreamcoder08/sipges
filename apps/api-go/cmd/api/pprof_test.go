package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"testing"
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
	for _, addr := range []string{"127.0.0.1:6061", "[::1]:6061", "localhost:6061", "127.0.0.2:0"} {
		got, err := pprofAddress(lookup(map[string]string{pprofEnv: addr}))
		if got != addr || err != nil {
			t.Errorf("%q: got %q, err = %v", addr, got, err)
		}
	}
	for _, addr := range []string{":6061", "0.0.0.0:6061", "[::]:6061", "192.0.2.1:6061", "example.com:6061", "127.0.0.1", "127.0.0.1:"} {
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

func TestStartPprofServesProfilesUntilCancel(t *testing.T) {
	t.Parallel()
	if err := startPprof(context.Background(), "", nil, nil); err != nil {
		t.Fatalf("empty address: %v", err)
	}
	addrs := make(chan string, 1)
	listen := func(network, _ string) (net.Listener, error) {
		ln, err := net.Listen(network, "127.0.0.1:0")
		if err == nil {
			addrs <- ln.Addr().String()
		}
		return ln, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	log := slog.New(slog.DiscardHandler)
	if err := startPprof(ctx, "127.0.0.1:0", listen, log); err != nil {
		t.Fatal(err)
	}
	url := "http://" + <-addrs + "/debug/pprof/cmdline"
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	cancel()
	for range 100 {
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return
		}
		_ = res.Body.Close()
	}
	t.Fatal("pprof server still answers after cancel")
}

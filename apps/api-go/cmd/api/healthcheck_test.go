package main

import (
	"bytes"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

// healthServer answers /health/ready with status and records the Host it was asked for.
func healthServer(t *testing.T, status int) (port string, host *string) {
	t.Helper()
	var seen string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Host
		if r.URL.Path != "/health/ready" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(status)
	}))
	t.Cleanup(srv.Close)
	_, port, err := net.SplitHostPort(srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	return port, &seen
}

func TestHealthcheckPassesWhenTheAPIIsReady(t *testing.T) {
	t.Parallel()
	port, host := healthServer(t, http.StatusOK)
	env := lookup(map[string]string{"SIPGES_PORT": port, "SIPGES_ALLOWED_HOSTS": "sipges.example.test,localhost"})
	if err := dispatch(t.Context(), []string{"healthcheck"}, env, &bytes.Buffer{}, nil); err != nil {
		t.Fatalf("healthcheck = %v, want nil", err)
	}
	// The host allowlist answers 400 to any other name, so the check speaks as the site.
	if *host != "sipges.example.test" {
		t.Fatalf("Host = %q, want the first allowed host", *host)
	}
}

func TestHealthcheckFailsWhenTheAPIIsNotReady(t *testing.T) {
	t.Parallel()
	port, _ := healthServer(t, http.StatusServiceUnavailable)
	env := lookup(map[string]string{"SIPGES_PORT": port})
	if err := dispatch(t.Context(), []string{"healthcheck"}, env, &bytes.Buffer{}, nil); err == nil {
		t.Fatal("healthcheck = nil for a 503, want an error")
	}
}

func TestHealthcheckFailsWhenNothingListens(t *testing.T) {
	t.Parallel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	env := lookup(map[string]string{"SIPGES_PORT": port})
	if err := dispatch(t.Context(), []string{"healthcheck"}, env, &bytes.Buffer{}, nil); err == nil {
		t.Fatal("healthcheck = nil with nothing listening, want an error")
	}
}

func TestHealthcheckRefusesABadPort(t *testing.T) {
	t.Parallel()
	env := lookup(map[string]string{"SIPGES_PORT": "eighty"})
	if err := dispatch(t.Context(), []string{"healthcheck"}, env, &bytes.Buffer{}, nil); err == nil {
		t.Fatal("healthcheck = nil for a bad port, want an error")
	}
}

// The check reads SIPGES_PORT and SIPGES_ALLOWED_HOSTS exactly as the API does, so it never asks
// for a name or a port the API itself would not use.
func TestHealthcheckSpeaksAsTheFirstHostTheAPIAllows(t *testing.T) {
	t.Parallel()
	port, host := healthServer(t, http.StatusOK)
	env := lookup(map[string]string{"SIPGES_PORT": port, "SIPGES_ALLOWED_HOSTS": " , Sipges.Example.Test,localhost"})
	if err := dispatch(t.Context(), []string{"healthcheck"}, env, &bytes.Buffer{}, nil); err != nil {
		t.Fatalf("healthcheck = %v, want nil", err)
	}
	if *host != "sipges.example.test" {
		t.Fatalf("Host = %q, want sipges.example.test (blank entries skipped, lower case)", *host)
	}
}

func TestHealthcheckRefusesAPortTheAPIRefuses(t *testing.T) {
	t.Parallel()
	port, _ := healthServer(t, http.StatusOK)
	env := lookup(map[string]string{"SIPGES_PORT": "+" + port})
	if err := dispatch(t.Context(), []string{"healthcheck"}, env, &bytes.Buffer{}, nil); err == nil {
		t.Fatal("healthcheck = nil for a signed port the API refuses, want an error")
	}
}

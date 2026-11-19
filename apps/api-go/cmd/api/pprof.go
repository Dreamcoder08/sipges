package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/pprof"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/config"
)

// pprofEnv names the loopback address of the profiling server. It is off unless set, and only a
// loopback address is accepted: profiles show code paths and timings, never for the network.
const pprofEnv = "SIPGES_GO_PPROF_ADDR"

// errPprofAddr is returned for a profiling address that is not host:port on loopback.
var errPprofAddr = errors.New(pprofEnv + " must be a loopback host:port, such as 127.0.0.1:6061")

// pprofAddress reads pprofEnv: "" when it is unset or empty, an error when it is not loopback.
func pprofAddress(lookup config.Lookup) (string, error) {
	addr, ok := lookup(pprofEnv)
	if !ok || addr == "" {
		return "", nil
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil || port == "" {
		return "", errPprofAddr
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return "", errPprofAddr
	}
	return addr, nil
}

// pprofHandler serves net/http/pprof on its own mux, so nothing reaches http.DefaultServeMux.
func pprofHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	return mux
}

// startPprof serves the profiles on addr until ctx ends; addr "" starts nothing.
func startPprof(ctx context.Context, addr string, listen listenFunc, log *slog.Logger) error {
	if addr == "" {
		return nil
	}
	ln, err := listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("pprof listen: %w", err)
	}
	srv := &http.Server{Handler: pprofHandler(), ReadHeaderTimeout: 5 * time.Second}
	log.Warn("pprof_listening", slog.String("address", ln.Addr().String()))
	go func() { _ = srv.Serve(ln) }()
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	return nil
}

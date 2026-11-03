// Command spike serves /health and /db-ping for the ADR 0032 hosting gate.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/dreamcoder08/sipges/spikes/go-container/internal/dbping"
	"github.com/dreamcoder08/sipges/spikes/go-container/internal/httpapi"
	"github.com/dreamcoder08/sipges/spikes/go-container/internal/postgres"
)

func main() {
	startedAt := time.Now()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Getenv, logger, startedAt); err != nil {
		logger.Error("spike stopped", "error", err)
		os.Exit(1)
	}
}

type config struct {
	addr      string
	targets   map[string]string // target name -> DSN
	placement httpapi.Placement
}

// loadConfig reads the environment. Database URLs are optional so /health
// works even before the secrets are set.
func loadConfig(getenv func(string) string) config {
	port := getenv("PORT")
	if port == "" {
		port = "8080"
	}
	targets := map[string]string{}
	for name, key := range map[string]string{"direct": "DATABASE_URL", "pooled": "DATABASE_URL_POOLED"} {
		if dsn := getenv(key); dsn != "" {
			targets[name] = dsn
		}
	}
	return config{
		addr:    net.JoinHostPort("", port),
		targets: targets,
		placement: httpapi.Placement{
			Location: getenv("CLOUDFLARE_LOCATION"),
			Region:   getenv("CLOUDFLARE_REGION"),
			Country:  getenv("CLOUDFLARE_COUNTRY_A2"),
		},
	}
}

func run(ctx context.Context, getenv func(string) string, logger *slog.Logger, startedAt time.Time) error {
	cfg := loadConfig(getenv)
	connectors := make(map[string]dbping.Connector, len(cfg.targets))
	names := make([]string, 0, len(cfg.targets))
	for name, dsn := range cfg.targets {
		connectors[name] = postgres.NewConnector(dsn)
		names = append(names, name)
	}

	server := &http.Server{
		Addr: cfg.addr,
		Handler: httpapi.New(httpapi.Deps{
			Targets:    connectors,
			Placement:  cfg.placement,
			StartedAt:  startedAt,
			Now:        time.Now,
			Logger:     logger,
			TraceURL:   "https://www.cloudflare.com/cdn-cgi/trace",
			HTTPClient: &http.Client{Timeout: 10 * time.Second},
		}),
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	listener, err := net.Listen("tcp", cfg.addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", cfg.addr, err)
	}
	logger.Info("listening", "addr", cfg.addr, "targets", names, "region", cfg.placement.Region,
		"location", cfg.placement.Location, "startupMs", time.Since(startedAt).Milliseconds())

	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()

	select {
	case err := <-serveErr:
		return fmt.Errorf("serve: %w", err)
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	if err := <-serveErr; !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve: %w", err)
	}
	return nil
}

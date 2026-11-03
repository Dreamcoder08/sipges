// Command api is the composition root of the Go backend (docs/adr/0032): it reads the
// configuration, wires the database pool and the HTTP handler, and shuts down on SIGINT/SIGTERM.
package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/config"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/logging"
)

// shutdownGrace bounds how long in-flight requests may run after SIGTERM.
const shutdownGrace = 10 * time.Second

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.LookupEnv, os.Stdout, net.Listen); err != nil {
		fmt.Fprintln(os.Stderr, "sipges-api-go:", err)
		stop()
		os.Exit(1) //nolint:gocritic // stop already ran; nothing else is deferred
	}
}

func run(ctx context.Context, lookup config.Lookup, stdout io.Writer, listen func(network, address string) (net.Listener, error)) error {
	cfg, err := config.Load(lookup)
	if err != nil {
		return err
	}
	log := logging.New(stdout, slog.LevelInfo)
	pool, err := database.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	handler, err := app.NewHandler(pool, app.Options{
		Logger:        log,
		AllowedHosts:  cfg.AllowedHosts,
		AccessLog:     cfg.AccessLog,
		RequireMFA:    cfg.RequireMFA,
		GoogleEnabled: cfg.GoogleEnabled,
	})
	if err != nil {
		return err
	}
	ln, err := listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	log.Info("listening", slog.String("address", ln.Addr().String()))
	if err := httpx.Serve(ctx, httpx.NewServer(handler), ln, shutdownGrace); err != nil {
		return err
	}
	log.Info("stopped")
	return nil
}

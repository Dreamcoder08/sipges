// Command api is the composition root of the Go backend (docs/adr/0032): it reads the
// configuration, wires the database pool and the HTTP handler, and shuts down on SIGINT/SIGTERM.
package main

import (
	"context"
	"errors"
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
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/engines"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/logging"
)

// shutdownGrace bounds how long in-flight requests may run after SIGTERM.
const shutdownGrace = 10 * time.Second

// drainGrace bounds how long automation ticks may finish after the server stopped.
const drainGrace = 20 * time.Second

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
	pool, err := database.OpenForServing(ctx, cfg.DatabaseURL, cfg.AllowPrivilegedRole)
	if err != nil {
		return err
	}
	defer pool.Close()
	compiled, err := engines.Shared(ctx)
	if err != nil {
		return err
	}

	bootstrap := app.NewIdentityBootstrap(pool, lookup, log, nil)
	// Engines is set, so NewHandler never compiles them with its own background context.
	handler, err := app.NewHandler(pool, app.Options{ //nolint:contextcheck // see above
		Engines:            compiled,
		Logger:             log,
		AllowedHosts:       cfg.AllowedHosts,
		AccessLog:          cfg.AccessLog,
		RequireMFA:         cfg.RequireMFA,
		GoogleEnabled:      cfg.GoogleEnabled,
		WebDir:             cfg.WebDir,
		HSTS:               cfg.CookieSecure,
		ReadyGate:          bootstrap.Ready,
		AutomationInterval: cfg.AutomationInterval,
	})
	if err != nil {
		return err
	}
	ln, err := listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	log.Info("listening", slog.String("address", ln.Addr().String()))
	// The API listens first: /health stays up while the bootstrap retries, and a bootstrap that
	// can never succeed stops the server gracefully through this context.
	serveCtx, stopServing := context.WithCancelCause(ctx)
	defer stopServing(nil)
	bootstrap.Start(serveCtx)
	app.StartAutomationSchedule(serveCtx, pool, log)
	go func() {
		select {
		case err := <-bootstrap.Failed():
			stopServing(err)
		case <-serveCtx.Done():
		}
	}()
	serveErr := httpx.Serve(serveCtx, httpx.NewServer(handler), ln, shutdownGrace)
	stopServing(nil) // a server that failed on its own also ends the retries
	// The signal already cancelled ctx: ticks get their own bound, and the deferred pool.Close
	// waits for this. A tick still running past it is retried after its lease.
	drainCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), drainGrace)
	defer cancel()
	if err := bootstrap.Wait(drainCtx); err != nil {
		log.Error("identity_bootstrap_drain_incomplete")
	}
	if err := app.DrainBackground(drainCtx, pool); err != nil {
		log.Error("automation_drain_incomplete", slog.String("error", err.Error()))
	}
	if cause := context.Cause(serveCtx); !errors.Is(cause, context.Canceled) {
		return cause
	}
	if serveErr != nil {
		return serveErr
	}
	log.Info("stopped")
	return nil
}

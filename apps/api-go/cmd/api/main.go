// Command api is the composition root of the Go backend (docs/adr/0032): it reads the
// configuration, wires the database pool and the HTTP handler, and shuts down on SIGINT/SIGTERM.
package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	identityapp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	identityinfra "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/config"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/logging"
	tenancyapp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/application"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
	tenancyinfra "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/infrastructure"
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

	// Sessions and grants are read on the base role's pool: sipges_tenant cannot see them.
	identity := identityapp.NewService(identityinfra.SessionStore{DB: pool}, time.Now)
	tenancy := tenancyapp.NewService(tenancyinfra.GrantStore{DB: pool}, time.Now)
	username := func(r *http.Request) (string, bool) {
		p := identityhttp.PrincipalFrom(r.Context())
		if p == nil {
			return "", false
		}
		return p.Username, true
	}
	handler := httpx.NewHandler(httpx.Options{
		Logger:       log,
		Ready:        database.Ping(pool),
		AllowedHosts: cfg.AllowedHosts,
		AccessLog:    cfg.AccessLog,
		Routes: func(mux *http.ServeMux) {
			identityhttp.Routes(mux, identity, cfg.GoogleEnabled, log)
		},
		// The order of createApp: session, tenancy, role gate.
		Pipeline: []httpx.Middleware{
			identityhttp.Session(identity, cfg.RequireMFA, log),
			tenancyhttp.Tenancy(tenancy, username, log),
			identityhttp.RoleGate(),
		},
	})
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

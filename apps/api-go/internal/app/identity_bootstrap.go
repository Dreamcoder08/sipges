package app

import (
	"context"
	"errors"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
	identity "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	tenancydomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/infrastructure"
)

// Log messages of the bootstrap. Only these and a SQLSTATE are ever logged: driver errors may
// quote a connection string or a stored value.
const (
	msgUnmigrated = "identity bootstrap is waiting for migrations: the database has no users table, or an old one; apply the migrations"
	msgRetry      = "identity bootstrap failed; retrying"
	msgDone       = "identity bootstrap finished"
	msgPermanent  = "identity bootstrap cannot succeed; stopping"
)

const (
	bootstrapFirstDelay = time.Second
	bootstrapMaxDelay   = 30 * time.Second
	// bootstrapAttemptTimeout bounds one attempt, so a hung connection cannot end the retries.
	bootstrapAttemptTimeout = 30 * time.Second
)

// PostgreSQL's undefined_table and undefined_column: the schema is older than this binary.
const (
	sqlstateUndefinedTable  = "42P01"
	sqlstateUndefinedColumn = "42703"
)

var errBootstrapPending = errors.New("identity bootstrap has not finished")

// bootstrapSettings is config.ts `admin` and the Google administrator's address.
type bootstrapSettings struct {
	admin       application.BootstrapAdmin
	googleEmail string
}

// readBootstrapSettings is config.ts: the username defaults to 'admin' only when unset, the
// password is kept as written, and a blank name or address counts as unset. config.Load already
// refused an address without a Google client.
func readBootstrapSettings(lookup func(string) (string, bool)) bootstrapSettings {
	username, set := lookup("SIPGES_ADMIN_USERNAME")
	if !set {
		username = "admin"
	}
	password, _ := lookup("SIPGES_ADMIN_PASSWORD")
	name, _ := lookup("SIPGES_ADMIN_FULL_NAME")
	if name = domain.TrimJS(name); name == "" {
		name = "Administrator"
	}
	email, _ := lookup("SIPGES_GOOGLE_ADMIN_EMAIL")
	return bootstrapSettings{
		admin:       application.BootstrapAdmin{Username: domain.NormalizeUsername(username), Password: password, FullName: name},
		googleEmail: domain.TrimJS(email),
	}
}

// IdentityBootstrap is the end of compose.ts's identity step: the first administrator on an
// empty installation, then the Google administrator's link. TypeScript stops its start on any
// failure; here the API listens first, so /health stays up during a database outage. The steps
// retry with a capped backoff until they succeed, and /health/ready answers 503 until then.
// Both steps are idempotent, so a retry after a partial success changes nothing. Only an
// environment that can never work stops the process.
type IdentityBootstrap struct {
	attempt func(context.Context) error
	sleep   func(context.Context, time.Duration) bool
	log     *slog.Logger
	started atomic.Bool
	ready   atomic.Bool
	done    chan struct{}
	failed  chan error
}

// NewIdentityBootstrap prepares the bootstrap; nothing runs until Start. now nil means time.Now.
func NewIdentityBootstrap(pool *pgxpool.Pool, lookup func(string) (string, bool), log *slog.Logger, now func() time.Time) *IdentityBootstrap {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	settings := readBootstrapSettings(lookup)
	return &IdentityBootstrap{
		attempt: func(ctx context.Context) error {
			store := identity.Store{DB: pool}
			service := application.NewBootstrapper(application.Deps{
				Accounts: store, Google: store, Hasher: identity.Passwords{}, Logger: log, Now: now,
			})
			if err := service.BootstrapAdmin(ctx, settings.admin); err != nil {
				return err
			}
			if settings.googleEmail != "" {
				if err := service.BootstrapGoogleAdmin(ctx, settings.admin.Username, settings.googleEmail); err != nil {
					return err
				}
			}
			return bootstrapTenancy(ctx, pool, now)
		},
		sleep:  sleepFor,
		log:    log,
		done:   make(chan struct{}),
		failed: make(chan error, 1),
	}
}

// bootstrapTenancy is tenancy.bootstrap of compose.ts, which ran next to Go until now: the default
// project exists and every administrator reaches it. Without TypeScript nothing else does this,
// and an install would have no project at all. Both statements change nothing on a second run.
func bootstrapTenancy(ctx context.Context, pool *pgxpool.Pool, now func() time.Time) error {
	at := time.Now()
	if now != nil {
		at = now()
	}
	store := tenancy.NewStore(pool)
	if err := store.EnsureTenant(ctx, tenancydomain.DefaultScope, tenancydomain.DefaultScopeLabel, at); err != nil {
		return err
	}
	return store.GrantDefaultToAdmins(ctx, at)
}

func sleepFor(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

// Ready is the readiness gate: nil once the bootstrap succeeded.
func (b *IdentityBootstrap) Ready(context.Context) error {
	if b.ready.Load() {
		return nil
	}
	return errBootstrapPending
}

// Failed delivers the error that must stop the process, at most once.
func (b *IdentityBootstrap) Failed() <-chan error { return b.failed }

// Start runs the bootstrap in the background until it succeeds, cannot succeed, or ctx ends.
func (b *IdentityBootstrap) Start(ctx context.Context) {
	b.started.Store(true)
	go func() {
		defer close(b.done)
		b.run(ctx)
	}()
}

// Wait returns when the retry loop ended, or with ctx's error. A bootstrap never started holds
// nothing.
func (b *IdentityBootstrap) Wait(ctx context.Context) error {
	if !b.started.Load() {
		return nil
	}
	select {
	case <-b.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (b *IdentityBootstrap) run(ctx context.Context) {
	delay := bootstrapFirstDelay
	for ctx.Err() == nil {
		attemptCtx, cancel := context.WithTimeout(ctx, bootstrapAttemptTimeout)
		err := b.attempt(attemptCtx)
		cancel()
		switch {
		case err == nil:
			b.ready.Store(true)
			b.log.LogAttrs(ctx, slog.LevelInfo, msgDone)
			return
		case ctx.Err() != nil:
			return
		case errors.Is(err, application.ErrBootstrapPassword), errors.Is(err, application.ErrBootstrapUsername),
			errors.Is(err, application.ErrBootstrapGoogleEmail):
			b.log.LogAttrs(ctx, slog.LevelError, msgPermanent)
			b.failed <- err
			return
		}
		b.report(ctx, err)
		if !b.sleep(ctx, delay) {
			return
		}
		delay = min(2*delay, bootstrapMaxDelay)
	}
}

// report names an unmigrated database, every time; any other failure logs its SQLSTATE at most.
func (b *IdentityBootstrap) report(ctx context.Context, err error) {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		b.log.LogAttrs(ctx, slog.LevelWarn, msgRetry)
		return
	}
	if pgErr.Code == sqlstateUndefinedTable || pgErr.Code == sqlstateUndefinedColumn {
		b.log.LogAttrs(ctx, slog.LevelError, msgUnmigrated, slog.String("sqlstate", pgErr.Code))
		return
	}
	b.log.LogAttrs(ctx, slog.LevelWarn, msgRetry, slog.String("sqlstate", pgErr.Code))
}

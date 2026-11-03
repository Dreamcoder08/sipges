// Package database opens the PostgreSQL pool and runs tenant transactions (docs/adr/0003).
package database

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DefaultMinConns is the warm pool: connections pgx opens in the background at start and keeps
// open, so a request never pays for a new connection (170–230 ms from the container to Neon,
// docs/adr/0032 §4). pgx's health check (every minute) replaces dropped ones; the URL's
// pool_min_conns overrides it.
const DefaultMinConns = 2

// Open parses url and returns a pool that never blocks the start: the warm connections open in
// the background, so a database outage shows in readiness instead of stopping the process. Pool
// size and other pgx settings come from the URL (pool_max_conns, pool_min_conns, …).
func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		// The parse error may quote the URL: never echo it.
		return nil, errors.New("SIPGES_DATABASE_URL is not a valid PostgreSQL connection string")
	}
	// Tenant settings are inlined as escaped literals, which is safe only with an ASCII-safe
	// client encoding: force UTF8 whatever the URL says.
	cfg.ConnConfig.RuntimeParams["client_encoding"] = "UTF8"
	if _, ok := cfg.ConnConfig.RuntimeParams["application_name"]; !ok {
		cfg.ConnConfig.RuntimeParams["application_name"] = "sipges-api-go"
	}
	if !strings.Contains(url, "pool_min_conns") {
		cfg.MinConns = DefaultMinConns
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open database pool: %w", err)
	}
	return pool, nil
}

// Ping is the readiness probe: the database answers through the pool the API uses.
func Ping(pool *pgxpool.Pool) func(context.Context) error {
	return pool.Ping
}

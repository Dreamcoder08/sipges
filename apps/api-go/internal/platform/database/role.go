package database

import (
	"context"
	"errors"
	"net"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	// ErrPrivilegedRole refuses a login that would bypass the row-level security isolating tenants.
	ErrPrivilegedRole = errors.New("the database login role must not be a superuser or have BYPASSRLS")
	// ErrOverrideNotLoopback refuses the test override on a database outside this machine.
	ErrOverrideNotLoopback = errors.New("SIPGES_ALLOW_PRIVILEGED_DB_ROLE works only on a loopback database")
)

// startCheckTimeout bounds how long a server that does not answer delays the start.
const startCheckTimeout = 5 * time.Second

const privilegedLogin = `SELECT EXISTS (SELECT 1 FROM pg_roles
  WHERE rolname IN (session_user, current_user) AND (rolsuper OR rolbypassrls))`

// OpenForServing is Open for the API process. Every new connection proves its login role cannot
// bypass row-level security, so a role changed later, or one first reached after an outage, is
// refused too. A server that answers at start settles it there: ErrPrivilegedRole stops the
// process. A server that does not answer never stops the start, as with Open. allowPrivileged
// lifts the check for a synthetic test server, on loopback only.
func OpenForServing(ctx context.Context, url string, allowPrivileged bool) (*pgxpool.Pool, error) {
	cfg, err := parseConfig(url)
	if err != nil {
		return nil, err
	}
	if allowPrivileged {
		if !onLoopback(cfg.ConnConfig.Config) {
			return nil, ErrOverrideNotLoopback
		}
		return open(ctx, url, cfg)
	}
	cfg.AfterConnect = refusePrivileged
	pool, err := open(ctx, url, cfg)
	if err != nil {
		return nil, err
	}
	checkCtx, cancel := context.WithTimeout(ctx, startCheckTimeout)
	defer cancel()
	conn, err := pool.Acquire(checkCtx)
	if errors.Is(err, ErrPrivilegedRole) {
		pool.Close()
		return nil, err
	}
	if err == nil {
		conn.Release()
	}
	return pool, nil
}

func refusePrivileged(ctx context.Context, conn *pgx.Conn) error {
	var privileged bool
	if err := conn.QueryRow(ctx, privilegedLogin, pgx.QueryExecModeSimpleProtocol).Scan(&privileged); err != nil {
		return err
	}
	if privileged {
		return ErrPrivilegedRole
	}
	return nil
}

func onLoopback(cfg pgconn.Config) bool {
	if !isLoopback(cfg.Host) {
		return false
	}
	for _, fallback := range cfg.Fallbacks {
		if !isLoopback(fallback.Host) {
			return false
		}
	}
	return true
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

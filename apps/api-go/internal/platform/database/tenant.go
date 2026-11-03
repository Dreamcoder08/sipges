package database

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var (
	// ErrTenantRequired rejects an empty tenant id before any transaction opens.
	ErrTenantRequired = errors.New("tenant id is required")
	// ErrInvalidSetting rejects a tenant setting PostgreSQL text cannot hold as one literal:
	// a NUL character or invalid UTF-8.
	ErrInvalidSetting = errors.New("tenant settings cannot contain NUL characters or invalid UTF-8")
)

// Querier is what work inside a tenant transaction may run. *pgxpool.Pool, *pgx.Conn and
// pgx.Tx satisfy it too. Like pgx.Tx, it must not be used from several goroutines at once.
type Querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Beginner opens a transaction; *pgxpool.Pool and *pgx.Conn satisfy it.
type Beginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// WithTenant runs fn in a transaction scoped to one tenant (docs/adr/0003), with the semantics of
// apps/api/src/platform/database/tenant-transaction.ts:
//   - app.tenant_id, app.actor and app.clearance are set transaction-locally and the
//     transaction drops to the non-owner role sipges_tenant, so RLS policies apply and global
//     tables (users, sessions, grants) are unreadable;
//   - an invalid tenant id fails before the transaction opens, and fn never runs;
//   - the tenant statement is sent right behind fn's first query, in one round trip; if
//     entering fails, PostgreSQL rejects that query (25P02), fn sees nothing from it, and the
//     failure to enter is the error returned, even when fn returns an error of its own;
//   - an error from fn rolls the transaction back; all settings end with the transaction.
func WithTenant[T any](ctx context.Context, db Beginner, tenantID string, fn func(context.Context, Querier) (T, error)) (T, error) {
	var zero T
	statement, err := tenantStatement(ctx, tenantID)
	if err != nil {
		return zero, err
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		return zero, fmt.Errorf("begin tenant transaction: %w", err)
	}
	q := &tenantQuerier{tx: tx, statement: statement}
	result, workErr := fn(ctx, q)
	// Rows of the first query the work left open still hold the pipeline.
	if err := q.finishPipeline(); err != nil && workErr == nil {
		workErr = err
	}
	if !q.sent {
		// fn ran no query: enter anyway, so a failure to enter is still reported.
		q.enterErr = enter(ctx, tx, statement)
	}
	if q.enterErr != nil || workErr != nil {
		rollbackErr := tx.Rollback(context.WithoutCancel(ctx))
		if q.enterErr != nil {
			return zero, errors.Join(fmt.Errorf("enter tenant: %w", q.enterErr), ignoreClosed(rollbackErr))
		}
		return zero, errors.Join(workErr, ignoreClosed(rollbackErr))
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, fmt.Errorf("commit tenant transaction: %w", err)
	}
	return result, nil
}

// EnterTenant scopes an already open transaction to one tenant with the same settings and role
// as WithTenant, in one statement. For owner-side work on global tables that must commit with a
// tenant write: run the global statements first, because the role switch makes global tables
// unreadable for the rest of the transaction.
func EnterTenant(ctx context.Context, tx pgx.Tx, tenantID string) error {
	statement, err := tenantStatement(ctx, tenantID)
	if err != nil {
		return err
	}
	return enter(ctx, tx, statement)
}

// enter sends the statement alone. Without arguments pgx uses the simple protocol: one round trip.
func enter(ctx context.Context, tx pgx.Tx, statement string) error {
	_, err := tx.Exec(ctx, statement)
	return err
}

func ignoreClosed(err error) error {
	if errors.Is(err, pgx.ErrTxClosed) {
		return nil
	}
	return err
}

// tenantStatement builds the one statement for the tenant settings and role. The values are
// inlined as literals, as in the TypeScript API, so the statement needs no parameters and costs
// no extra round trip in either protocol; set_config('role', …, true) is SET LOCAL ROLE.
func tenantStatement(ctx context.Context, tenantID string) (string, error) {
	if tenantID == "" {
		return "", ErrTenantRequired
	}
	actor, ok := ActorFrom(ctx)
	if !ok {
		actor = Actor{Clearance: ClearanceFull}
	}
	tenant, err := literal(tenantID)
	if err != nil {
		return "", err
	}
	name, err := literal(actor.Name)
	if err != nil {
		return "", err
	}
	clearance, err := literal(string(actor.Clearance))
	if err != nil {
		return "", err
	}
	return `SELECT set_config('app.tenant_id', ` + tenant + `, true),
            set_config('app.actor', ` + name + `, true),
            set_config('app.clearance', ` + clearance + `, true),
            set_config('role', 'sipges_tenant', true)`, nil
}

var escaper = strings.NewReplacer(`\`, `\\`, `'`, `''`)

// literal returns an escape-string literal (E'…') with backslashes and quotes doubled, so the
// value stays one literal whatever standard_conforming_strings is. It is safe only with an
// ASCII-safe client encoding: Open forces UTF8, and invalid UTF-8 is refused here because a
// malformed lead byte is the one way a quote could be swallowed by another encoding.
func literal(value string) (string, error) {
	if strings.ContainsRune(value, 0) || !utf8.ValidString(value) {
		return "", ErrInvalidSetting
	}
	return "E'" + escaper.Replace(value) + "'", nil
}

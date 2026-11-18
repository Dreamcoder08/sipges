package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"

	"github.com/jackc/pgx/v5/pgconn"

	identityapp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
	identity "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/config"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/logging"
)

const resetMFAUsage = "Uso: sipges-api-go reset-mfa <usuario>"

// exitError ends the process with code after printing message alone to stderr: the operator
// commands of admin-cli.ts answer with their own exit codes and text.
type exitError struct {
	code    int
	message string
}

func (e *exitError) Error() string { return e.message }

// resetMFA is `node src/admin-cli.ts reset-mfa <username>`: it recovers an account, including the
// last administrator, whose authenticator was lost. The HTTP route refuses a self-reset, so this
// break-glass path works on the database directly, as the login the API serves with. Every call
// that names a user leaves one JSON line on stderr (time, command, username, outcome), and a
// reset is audited in each project the user is granted.
func resetMFA(ctx context.Context, args []string, lookup config.Lookup, stdout, stderr io.Writer) error {
	if len(args) != 2 || args[1] == "" {
		return &exitError{code: 2, message: resetMFAUsage}
	}
	username, outcome, err := runResetMFA(ctx, args[1], lookup)
	logOperatorCommand(ctx, stderr, username, outcome, err)
	if err != nil {
		return err
	}
	if outcome == identityapp.AccountMissing {
		return &exitError{code: 1, message: "Usuario inexistente: " + username}
	}
	_, err = fmt.Fprintf(stdout, "MFA restablecido para %s; registrará un autenticador nuevo al ingresar.\n", username)
	return err
}

// runResetMFA opens the pool and resets raw's factor; the username it answers is normalized even
// when the reset failed, for the log line.
func runResetMFA(ctx context.Context, raw string, lookup config.Lookup) (string, identityapp.AccountOutcome, error) {
	username := domain.NormalizeUsername(raw)
	url, _ := lookup("SIPGES_DATABASE_URL")
	if url == "" {
		return username, "", errors.New("SIPGES_DATABASE_URL is required")
	}
	allowPrivileged, err := privilegedOverride(lookup)
	if err != nil {
		return username, "", err
	}
	pool, err := database.OpenForServing(ctx, url, allowPrivileged)
	if err != nil {
		return username, "", resetMFAFailure(err)
	}
	defer pool.Close()
	service := identityapp.NewBootstrapper(identityapp.Deps{Accounts: identity.Store{DB: pool}})
	username, outcome, err := service.OperatorResetMFA(ctx, raw)
	if err != nil {
		return username, "", resetMFAFailure(err)
	}
	return username, outcome, nil
}

// logOperatorCommand writes the one trace a tenant-less reset always leaves. It carries no error
// text, which may quote a URL, and nothing secret: only the command, the user and the outcome.
func logOperatorCommand(ctx context.Context, stderr io.Writer, username string, outcome identityapp.AccountOutcome, err error) {
	result := "reset"
	switch {
	case err != nil:
		result = "failed"
	case outcome == identityapp.AccountMissing:
		result = "missing"
	}
	logging.New(stderr, slog.LevelInfo).LogAttrs(ctx, slog.LevelInfo, "operator_command",
		slog.String("command", "reset-mfa"), slog.String("username", username), slog.String("outcome", result))
}

// resetMFAFailure keeps PostgreSQL's own report and drops any other driver text, which may quote
// the URL.
func resetMFAFailure(err error) error {
	if errors.Is(err, database.ErrPrivilegedRole) || errors.Is(err, database.ErrOverrideNotLoopback) {
		return err
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return fmt.Errorf("reset-mfa failed: %s (SQLSTATE %s)", pg.Message, pg.Code)
	}
	return errors.New("the database could not be reached")
}

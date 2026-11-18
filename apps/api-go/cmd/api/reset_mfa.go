package main

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/jackc/pgx/v5/pgconn"

	identityapp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	identity "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/config"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
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
// break-glass path works on the database directly, as the login the API serves with.
func resetMFA(ctx context.Context, args []string, lookup config.Lookup, stdout io.Writer) error {
	if len(args) != 2 || args[1] == "" {
		return &exitError{code: 2, message: resetMFAUsage}
	}
	url, _ := lookup("SIPGES_DATABASE_URL")
	if url == "" {
		return errors.New("SIPGES_DATABASE_URL is required")
	}
	allowPrivileged, err := privilegedOverride(lookup)
	if err != nil {
		return err
	}
	pool, err := database.OpenForServing(ctx, url, allowPrivileged)
	if err != nil {
		return resetMFAFailure(err)
	}
	defer pool.Close()
	service := identityapp.NewBootstrapper(identityapp.Deps{Accounts: identity.Store{DB: pool}})
	username, outcome, err := service.OperatorResetMFA(ctx, args[1])
	if err != nil {
		return resetMFAFailure(err)
	}
	if outcome == identityapp.AccountMissing {
		return &exitError{code: 1, message: "Usuario inexistente: " + username}
	}
	_, err = fmt.Fprintf(stdout, "MFA restablecido para %s; registrará un autenticador nuevo al ingresar.\n", username)
	return err
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

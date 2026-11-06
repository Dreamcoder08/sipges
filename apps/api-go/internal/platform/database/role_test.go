package database_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

const probePassword = "synthetic-probe-password"

// probeRole creates a login role with the given attributes, dropped after the test. Roles are
// cluster-wide, so its name is unique.
func probeRole(t *testing.T, attributes string) string {
	t.Helper()
	requireDB(t)
	suffix := make([]byte, 4)
	_, _ = rand.Read(suffix)
	role := "probe_" + hex.EncodeToString(suffix)
	ctx := context.Background()
	if err := scratch.AdminExec(ctx, "CREATE ROLE "+role+" LOGIN PASSWORD '"+probePassword+"' "+attributes); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = scratch.AdminExec(context.Background(), "DROP ROLE IF EXISTS "+role) })
	return role
}

func TestOpenForServingRefusesALoginThatBypassesRowLevelSecurity(t *testing.T) {
	for name, url := range map[string]string{
		"superuser": func() string { requireDB(t); return scratch.URL }(),
		"bypassrls": func() string { return scratch.URLAs(probeRole(t, "NOSUPERUSER BYPASSRLS"), probePassword) }(),
	} {
		t.Run(name, func(t *testing.T) {
			pool, err := database.OpenForServing(t.Context(), url, false)
			if pool != nil {
				pool.Close()
			}
			if !errors.Is(err, database.ErrPrivilegedRole) {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestOpenForServingAcceptsAnOrdinaryLogin(t *testing.T) {
	url := scratch.URLAs(probeRole(t, "NOSUPERUSER NOBYPASSRLS"), probePassword)
	pool, err := database.OpenForServing(t.Context(), url, false)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := database.Ping(pool)(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestOpenForServingAllowsTheTestOverrideOnLoopbackOnly(t *testing.T) {
	requireDB(t)
	pool, err := database.OpenForServing(t.Context(), scratch.URL, true)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := database.Ping(pool)(t.Context()); err != nil {
		t.Fatal(err)
	}

	_, err = database.OpenForServing(t.Context(), "postgres://u:synthetic-secret@db.example.org:5432/db", true)
	if !errors.Is(err, database.ErrOverrideNotLoopback) {
		t.Fatalf("got %v", err)
	}
}

func TestOpenForServingStartsDuringAnOutageAndGuardsEveryLaterConnection(t *testing.T) {
	pool, err := database.OpenForServing(context.Background(), unreachable, false)
	if err != nil {
		t.Fatalf("an outage must not stop the start: %v", err)
	}
	defer pool.Close()
	if err := database.Ping(pool)(context.Background()); err == nil {
		t.Fatal("reached an unreachable server")
	}
}

func TestAPoolStaysGuardedWhenARoleGainsPrivilegesLater(t *testing.T) {
	role := probeRole(t, "NOSUPERUSER NOBYPASSRLS")
	ctx := context.Background()
	pool, err := database.OpenForServing(ctx, scratch.URLAs(role, probePassword), false)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := scratch.AdminExec(ctx, "ALTER ROLE "+role+" BYPASSRLS"); err != nil {
		t.Fatal(err)
	}
	pool.Reset() // every next connection is new
	if err := database.Ping(pool)(ctx); !errors.Is(err, database.ErrPrivilegedRole) {
		t.Fatalf("got %v", err)
	}
}

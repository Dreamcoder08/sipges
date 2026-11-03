package infrastructure_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

var pool *pgxpool.Pool

func TestMain(m *testing.M) { os.Exit(run(m)) }

func run(m *testing.M) int {
	adminURL := os.Getenv(dbtest.EnvAdminURL)
	if adminURL == "" {
		return m.Run()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	s, err := dbtest.NewScratch(ctx, adminURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "scratch database:", err)
		return 1
	}
	defer func() { _ = s.Drop(context.Background()) }()
	conn, err := pgx.Connect(ctx, s.URL)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	// Synthetic users and sessions; hashes are of the tokens "t-<name>".
	_, err = conn.Exec(ctx, fmt.Sprintf(`
		INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
		  ('ana', 'Ana Sintética', 'x', 'admin', true, true),
		  ('beto', 'Beto Sintético', 'x', 'consulta', true, false),
		  ('caro', 'Caro Inactiva', 'x', 'analista', false, true);
		INSERT INTO sessions (token_hash, username, expires_at, via_google) VALUES
		  ('%s', 'ana', '2030-01-01T00:00:00Z', false),
		  ('%s', 'beto', '2030-01-01T00:00:00Z', true),
		  ('%s', 'beto', '2020-01-01T00:00:00Z', false),
		  ('%s', 'caro', '2030-01-01T00:00:00Z', false);`,
		domain.HashSessionToken("t-ana"), domain.HashSessionToken("t-beto-google"),
		domain.HashSessionToken("t-beto-expired"), domain.HashSessionToken("t-caro")))
	_ = conn.Close(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "seed:", err)
		return 1
	}
	if pool, err = pgxpool.New(ctx, s.URL); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer pool.Close()
	return m.Run()
}

func TestFindSessionIdentity(t *testing.T) {
	if pool == nil {
		t.Skip("set " + dbtest.EnvAdminURL)
	}
	store := infrastructure.SessionStore{DB: pool}
	at := time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		token string
		want  *domain.Principal
	}{
		{"t-ana", &domain.Principal{Username: "ana", FullName: "Ana Sintética", Role: "admin", MFAEnabled: true}},
		{"t-beto-google", &domain.Principal{Username: "beto", FullName: "Beto Sintético", Role: "consulta", MFAEnabled: true}},
		{"t-beto-expired", nil},
		{"t-caro", nil},
		{"t-unknown", nil},
	}
	for _, c := range cases {
		got, err := store.FindSessionIdentity(context.Background(), domain.HashSessionToken(c.token), at)
		if err != nil {
			t.Fatal(err)
		}
		if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
			t.Errorf("%s: got %+v, want %+v", c.token, got, c.want)
		}
	}
	// The clock is the caller's, not the database's: the same session is expired later on.
	got, err := store.FindSessionIdentity(context.Background(), domain.HashSessionToken("t-ana"), time.Date(2031, 1, 1, 0, 0, 0, 0, time.UTC))
	if err != nil || got != nil {
		t.Errorf("after expiry: %+v %v", got, err)
	}
}

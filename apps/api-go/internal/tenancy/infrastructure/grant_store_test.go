package infrastructure_test

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/infrastructure"
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
	_, err = conn.Exec(ctx, `
		INSERT INTO users (username, full_name, password_hash, role) VALUES
		  ('ana', 'Ana', 'x', 'admin'), ('beto', 'Beto', 'x', 'consulta'), ('caro', 'Caro', 'x', 'analista');
		INSERT INTO tenants (company_id, project_id, label) VALUES
		  ('ZETA', 'PRJ-1', 'Z'), ('ALFA', 'PRJ-B', 'B'), ('ALFA', 'PRJ-A', 'A');
		INSERT INTO grants (username, tenant_id) VALUES
		  ('ana', 'ZETA/PRJ-1'), ('ana', 'ALFA/PRJ-B'), ('ana', 'ALFA/PRJ-A'), ('beto', 'ALFA/PRJ-B');`)
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

func TestListGrantsIsPerUserAndOrdered(t *testing.T) {
	if pool == nil {
		t.Skip("set " + dbtest.EnvAdminURL)
	}
	store := infrastructure.GrantStore{DB: pool}
	cases := map[string][]domain.Scope{
		"ana":  {{CompanyID: "ALFA", ProjectID: "PRJ-A"}, {CompanyID: "ALFA", ProjectID: "PRJ-B"}, {CompanyID: "ZETA", ProjectID: "PRJ-1"}},
		"beto": {{CompanyID: "ALFA", ProjectID: "PRJ-B"}},
		"caro": {},
	}
	for user, want := range cases {
		got, err := store.ListGrants(context.Background(), user)
		if err != nil {
			t.Fatal(err)
		}
		if got == nil {
			got = []domain.Scope{}
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %v, want %v", user, got, want)
		}
	}
}

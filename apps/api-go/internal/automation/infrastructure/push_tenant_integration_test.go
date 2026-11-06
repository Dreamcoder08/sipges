package infrastructure_test

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/infrastructure"
)

// The outbox runs on the login role, so these tests hold on a login that bypasses row-level
// security, as the synthetic servers' superusers do: its predicates alone keep the tenant.

const otherTenant = "ACME/NORTE"

// queuedPush adds one due delivery of tenantID for a subscriber granted that project.
func queuedPush(t *testing.T, pool *pgxpool.Pool, tenantID, username, device string, due time.Time) int64 {
	t.Helper()
	endpoint := subscribe(t, pool, username, "analista", device)
	if _, err := pool.Exec(t.Context(), `INSERT INTO grants (username, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, username, tenantID); err != nil {
		t.Fatal(err)
	}
	var id int64
	err := pool.QueryRow(t.Context(), `WITH n AS (
		  INSERT INTO notifications (tenant_id, title, created_at) VALUES ($1, 'Aviso', $4) RETURNING id)
		INSERT INTO push_deliveries (tenant_id, notification_id, endpoint, username, restricted, payload, next_attempt_at)
		SELECT $1, n.id, $2, $3, false, '{"title":"Aviso"}', $4 FROM n RETURNING id`,
		tenantID, endpoint, username, due).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestClaimLeavesTheDeliveriesOfAnotherProject(t *testing.T) {
	pool := scratchPool(t, tenant, otherTenant)
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	foreign := queuedPush(t, pool, otherTenant, "ajena", "ajena", now.Add(-time.Hour))
	own := queuedPush(t, pool, tenant, "propia", "propia", now)
	outbox := infrastructure.PushOutbox{DB: pool}

	claimed, err := outbox.Claim(t.Context(), tenant, now, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != 1 || claimed[0].ID != own {
		t.Fatalf("claimed %+v, want only delivery %d of this project", claimed, own)
	}
	var attempts int
	if err := pool.QueryRow(t.Context(), `SELECT attempts FROM push_deliveries WHERE id = $1`, foreign).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if attempts != 0 {
		t.Fatalf("the other project's delivery was claimed %d times", attempts)
	}
}

func TestFinishLeavesTheDeliveriesOfAnotherProject(t *testing.T) {
	pool := scratchPool(t, tenant, otherTenant)
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	foreign := queuedPush(t, pool, otherTenant, "ajena", "ajena", now)
	own := queuedPush(t, pool, tenant, "propia", "propia", now)
	outbox := infrastructure.PushOutbox{DB: pool}

	if err := outbox.Finish(t.Context(), tenant, foreign, "accepted", "", now); err != nil {
		t.Fatal(err)
	}
	if err := outbox.Finish(t.Context(), tenant, own, "accepted", "", now); err != nil {
		t.Fatal(err)
	}
	status := func(id int64) string {
		var s string
		if err := pool.QueryRow(t.Context(), `SELECT status FROM push_deliveries WHERE id = $1`, id).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	if got := status(foreign); got != "pending" {
		t.Fatalf("the other project's delivery became %q", got)
	}
	if got := status(own); got != "accepted" {
		t.Fatalf("this project's delivery stayed %q", got)
	}
}

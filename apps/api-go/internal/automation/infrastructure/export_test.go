package infrastructure

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// ClaimWith runs a claim statement of the same columns as claimDue (TypeScript's, in the tests).
func ClaimWith(ctx context.Context, q database.Querier, sql string, at time.Time, limit int, leaseUntil time.Time) ([]application.ClaimedRun, error) {
	return collectClaimed(q.Query(ctx, sql, at, limit, leaseUntil))
}

// ClaimPush is the claim statement, compared with TypeScript's in the tests.
const ClaimPush = claimPush

// ClaimPushWith runs a claim statement of the same columns as claimPush (TypeScript's, in the tests).
func ClaimPushWith(ctx context.Context, db *pgxpool.Pool, sql, tenantID string, at, leaseUntil time.Time) ([]application.PushDelivery, error) {
	return claimDeliveries(ctx, db, sql, tenantID, at, leaseUntil)
}

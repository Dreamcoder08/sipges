package infrastructure

import (
	"context"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// ClaimWith runs a claim statement of the same columns as claimDue (TypeScript's, in the tests).
func ClaimWith(ctx context.Context, q database.Querier, sql string, at time.Time, limit int, leaseUntil time.Time) ([]application.ClaimedRun, error) {
	return collectClaimed(q.Query(ctx, sql, at, limit, leaseUntil))
}

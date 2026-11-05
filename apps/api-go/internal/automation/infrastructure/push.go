package infrastructure

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
)

// PushOutbox is the enqueue of sql-push-store.ts: one push_deliveries row per active, granted
// subscriber of the tenant (not `consulta` for a restricted record). push_subscriptions, users
// and grants are global tables, so it runs as the owner with only app.tenant_id set, under the
// outbox's forced RLS. Claiming and sending (VAPID) stay in the TypeScript API.
type PushOutbox struct {
	DB *pgxpool.Pool
}

const enqueuePush = `INSERT INTO push_deliveries(tenant_id,notification_id,endpoint,username,restricted,payload,next_attempt_at)
 SELECT $1,$2,s.endpoint,s.username,$3,$4::jsonb,$5 FROM push_subscriptions s JOIN users u ON u.username=s.username AND u.active JOIN grants g ON g.username=s.username AND g.tenant_id=$1 WHERE NOT $3::boolean OR u.role<>'consulta' ON CONFLICT(notification_id,endpoint) DO NOTHING`

// Enqueue queues the notification's push for every eligible subscriber.
func (p PushOutbox) Enqueue(ctx context.Context, tenantID string, notificationID int64, restricted bool, payload application.PushPayload, at time.Time) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, p.DB, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id',$1,true)", tenantID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, enqueuePush, tenantID, notificationID, restricted, domain.PGText(string(body)), at)
		return err
	})
}

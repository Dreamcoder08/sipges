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
// outbox's forced RLS. Claiming and sending stay in the TypeScript API.
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

// Subscriptions is the subscriptions part of sql-push-store.ts, on the owner connection.
type Subscriptions struct {
	DB *pgxpool.Pool
}

var _ application.PushStore = Subscriptions{}

const (
	savePush = `INSERT INTO push_subscriptions (endpoint, username, p256dh, auth, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
         SET username = EXCLUDED.username, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`

	removePush = `DELETE FROM push_subscriptions WHERE endpoint = $1 AND username = $2`

	ownPushTargets = `SELECT s.endpoint,s.p256dh,s.auth FROM push_subscriptions s JOIN users u ON u.username=s.username AND u.active WHERE s.username=$1`

	forgetPush = `DELETE FROM push_subscriptions WHERE endpoint = $1`
)

// Save stores the subscription; an endpoint already known moves to this person.
func (p Subscriptions) Save(ctx context.Context, username string, s application.PushSubscription, at time.Time) error {
	_, err := p.DB.Exec(ctx, savePush, s.Endpoint, username, s.P256dh, s.Auth, at)
	return err
}

// Remove deletes the endpoint only when it is this person's.
func (p Subscriptions) Remove(ctx context.Context, username, endpoint string) error {
	_, err := p.DB.Exec(ctx, removePush, endpoint, username)
	return err
}

// OwnTargets lists the subscriptions of one active person.
func (p Subscriptions) OwnTargets(ctx context.Context, username string) ([]application.PushSubscription, error) {
	rows, err := p.DB.Query(ctx, ownPushTargets, username)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.PushSubscription, error) {
		var s application.PushSubscription
		err := row.Scan(&s.Endpoint, &s.P256dh, &s.Auth)
		return s, err
	})
}

// Forget drops a subscription the push service no longer knows.
func (p Subscriptions) Forget(ctx context.Context, endpoint string) error {
	_, err := p.DB.Exec(ctx, forgetPush, endpoint)
	return err
}

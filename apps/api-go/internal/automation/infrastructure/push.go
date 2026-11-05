package infrastructure

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
)

// PushOutbox is the outbox of sql-push-store.ts: one push_deliveries row per active, granted
// subscriber of the tenant (not `consulta` for a restricted record), claimed and settled by the
// ticks. push_subscriptions, users and grants are global tables, so it runs as the owner with
// only app.tenant_id set, under the outbox's forced RLS.
type PushOutbox struct {
	DB *pgxpool.Pool
}

const enqueuePush = `INSERT INTO push_deliveries(tenant_id,notification_id,endpoint,username,restricted,payload,next_attempt_at)
 SELECT $1,$2,s.endpoint,s.username,$3,$4::jsonb,$5 FROM push_subscriptions s JOIN users u ON u.username=s.username AND u.active JOIN grants g ON g.username=s.username AND g.tenant_id=$1 WHERE NOT $3::boolean OR u.role<>'consulta' ON CONFLICT(notification_id,endpoint) DO NOTHING`

// claimPush is the claim of sql-push-store.ts: one due row, skipping those another runner holds
// and those whose person lost access since it was queued, leased in the same statement.
const claimPush = `WITH due AS(
 SELECT d.id FROM push_deliveries d JOIN push_subscriptions s ON s.endpoint=d.endpoint AND s.username=d.username JOIN users u ON u.username=d.username AND u.active JOIN grants g ON g.username=d.username AND g.tenant_id=d.tenant_id
 WHERE d.status='pending' AND d.next_attempt_at<=$1 AND(NOT d.restricted OR u.role<>'consulta') ORDER BY d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED
 ),claimed AS(UPDATE push_deliveries d SET attempts=d.attempts+1,next_attempt_at=$2 FROM due WHERE d.id=due.id RETURNING d.*)
 SELECT c.id,s.endpoint,s.p256dh,s.auth,c.payload,c.attempts FROM claimed c JOIN push_subscriptions s ON s.endpoint=c.endpoint AND s.username=c.username`

const finishPush = `UPDATE push_deliveries SET status=$2,last_error=$3,next_attempt_at=$4 WHERE id=$1`

var _ application.PushDeliveries = PushOutbox{}

func inPushTenant(ctx context.Context, db *pgxpool.Pool, tenantID string, fn func(pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id',$1,true)", tenantID); err != nil {
			return err
		}
		return fn(tx)
	})
}

func claimDeliveries(ctx context.Context, db *pgxpool.Pool, sql, tenantID string, at, leaseUntil time.Time) ([]application.PushDelivery, error) {
	var out []application.PushDelivery
	err := inPushTenant(ctx, db, tenantID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, sql, at, leaseUntil)
		if err != nil {
			return err
		}
		out, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.PushDelivery, error) {
			var (
				d       application.PushDelivery
				payload []byte
			)
			if err := row.Scan(&d.ID, &d.Subscription.Endpoint, &d.Subscription.P256dh, &d.Subscription.Auth, &payload, &d.Attempts); err != nil {
				return d, err
			}
			if err := json.Unmarshal(payload, &d.Payload); err != nil {
				return d, errors.New("automation: unreadable push payload") // the decoder may quote it
			}
			return d, nil
		})
		return err
	})
	return out, err
}

// Claim leases the next due delivery of the tenant, if any.
func (p PushOutbox) Claim(ctx context.Context, tenantID string, at, leaseUntil time.Time) ([]application.PushDelivery, error) {
	return claimDeliveries(ctx, p.DB, claimPush, tenantID, at, leaseUntil)
}

// Finish settles a delivery.
func (p PushOutbox) Finish(ctx context.Context, tenantID string, id int64, status, errText string, retryAt time.Time) error {
	return inPushTenant(ctx, p.DB, tenantID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, finishPush, id, status, errText, retryAt)
		return err
	})
}

// Enqueue queues the notification's push for every eligible subscriber.
func (p PushOutbox) Enqueue(ctx context.Context, tenantID string, notificationID int64, restricted bool, payload application.PushPayload, at time.Time) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return inPushTenant(ctx, p.DB, tenantID, func(tx pgx.Tx) error {
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

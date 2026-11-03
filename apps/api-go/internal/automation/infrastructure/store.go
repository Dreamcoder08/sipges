// Package infrastructure reads automation rows from PostgreSQL with the queries of
// apps/api/src/contexts/automation/infrastructure/sql-automation-store.ts, inside the request's
// tenant transaction (docs/adr/0003, forced RLS; notifications also follow the clearance).
package infrastructure

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

const listRules = `SELECT id, name, enabled, trigger_module, trigger_actions, conditions, actions,
  created_by, created_at, updated_at FROM automation_rules ORDER BY name, id`

const listChannels = `SELECT id, kind, name, target_hint, created_by, created_at
           FROM integration_channels ORDER BY name, id`

const listRuns = `SELECT u.id, u.rule_id, r.name, u.kind, u.status, u.attempts, u.last_error, u.event,
                  u.created_at, u.finished_at, u.next_attempt_at
           FROM automation_runs u JOIN automation_rules r ON r.id = u.rule_id
           ORDER BY u.id DESC LIMIT $1`

// readInbox is the inbox statement of the TypeScript store: the count and the page in one
// round trip.
const readInbox = `SELECT
           (SELECT count(*) FROM notifications n
            WHERE NOT EXISTS (SELECT 1 FROM notification_reads r
                              WHERE r.notification_id = n.id AND r.username = $1)) AS unread,
           coalesce((SELECT json_agg(page ORDER BY page.id DESC) FROM (
             SELECT n.id, n.title, n.body, n.module, n.record_id, n.created_at,
                    (r.username IS NOT NULL) AS read
             FROM notifications n
             LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.username = $1
             ORDER BY n.id DESC LIMIT $2) page), '[]'::json) AS items`

// Store is the read side of the SQL automation store.
type Store struct{}

// Rules lists the tenant's rules by name, then id.
func (Store) Rules(ctx context.Context, q database.Querier) ([]application.Rule, error) {
	rows, err := q.Query(ctx, listRules)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.Rule, error) {
		var (
			r          application.Rule
			id         int32
			conditions []byte
			steps      []byte
			createdAt  time.Time
		)
		if err := row.Scan(&id, &r.Name, &r.Enabled, &r.Module, &r.Actions, &conditions, &steps,
			&r.CreatedBy, &createdAt, &r.UpdatedAt); err != nil {
			return r, err
		}
		r.ID = int64(id)
		if err := json.Unmarshal(conditions, &r.Conditions); err != nil {
			return r, err
		}
		return r, json.Unmarshal(steps, &r.Steps)
	})
}

// Channels lists the tenant's channels by name, then id, without their sealed configuration.
func (Store) Channels(ctx context.Context, q database.Querier) ([]application.Channel, error) {
	rows, err := q.Query(ctx, listChannels)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.Channel, error) {
		var (
			c  application.Channel
			id int32
		)
		err := row.Scan(&id, &c.Kind, &c.Name, &c.TargetHint, &c.CreatedBy, &c.CreatedAt)
		c.ID = int64(id)
		return c, err
	})
}

// Runs lists the tenant's latest runs, newest first.
func (Store) Runs(ctx context.Context, q database.Querier, limit int64) ([]application.Run, error) {
	rows, err := q.Query(ctx, listRuns, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.Run, error) {
		var (
			r                    application.Run
			id, ruleID, attempts int32
			event                []byte
		)
		err := row.Scan(&id, &ruleID, &r.RuleName, &r.Kind, &r.Status, &attempts, &r.LastError, &event,
			&r.CreatedAt, &r.FinishedAt, &r.NextAttemptAt)
		r.ID, r.RuleID, r.Attempts, r.Event = int64(id), int64(ruleID), int64(attempts), event
		return r, err
	})
}

// inboxItem is one element of the statement's json_agg page.
type inboxItem struct {
	ID        int64   `json:"id"`
	Title     string  `json:"title"`
	Body      string  `json:"body"`
	Module    *string `json:"module"`
	RecordID  *string `json:"record_id"`
	CreatedAt string  `json:"created_at"`
	Read      bool    `json:"read"`
}

// Inbox reads the user's unread count and latest notifications together.
func (Store) Inbox(ctx context.Context, q database.Querier, username string, limit int64) (application.Inbox, error) {
	var (
		unread int64
		items  []byte
	)
	if err := q.QueryRow(ctx, readInbox, username, limit).Scan(&unread, &items); err != nil {
		return application.Inbox{}, err
	}
	var page []inboxItem
	if err := json.Unmarshal(items, &page); err != nil {
		return application.Inbox{}, err
	}
	out := application.Inbox{Unread: unread, Items: make([]application.Notification, 0, len(page))}
	for _, item := range page {
		// json_agg writes timestamptz in ISO 8601 with the session's offset, as new Date reads it.
		created, err := time.Parse(time.RFC3339Nano, item.CreatedAt)
		if err != nil {
			return application.Inbox{}, err
		}
		out.Items = append(out.Items, application.Notification{ID: item.ID, Title: item.Title, Body: item.Body,
			Module: item.Module, RecordID: item.RecordID, CreatedAt: created, Read: item.Read})
	}
	return out, nil
}

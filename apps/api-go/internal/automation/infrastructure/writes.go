package infrastructure

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The write and runtime side of sql-automation-store.ts, statement for statement, so the Go
// and TypeScript APIs take the same locks and hit the same unique constraints when both run.

// CursorSettle is CURSOR_SETTLE_MS: how long an audit event may stay uncommitted after its
// timestamp and still be scanned. Audit ids are taken when a row is inserted, not when it
// commits, so a slower writer can commit a lower id after a higher one was scanned; the cursor
// only passes events older than this window, and newer ones are read again next time without
// duplicating their runs (automation_runs is unique per rule, audit id and step).
const CursorSettle = 60 * time.Second

const (
	appendAudit = `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5)`

	duplicateRule = `SELECT 1 FROM automation_rules WHERE name = $1 AND ($2::integer IS NULL OR id <> $2)`

	insertRule = `INSERT INTO automation_rules
             (tenant_id, name, enabled, trigger_module, trigger_actions, conditions, actions,
              created_by, created_at, updated_at)
           VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4::text[], $5::jsonb,
                   $6::jsonb, $8, $7, $7)
           RETURNING id`

	// The first current rule starts the cursor now; later rules preserve pending processing.
	startCursor = `INSERT INTO automation_cursors (tenant_id, last_audit_id)
           SELECT current_setting('app.tenant_id', true), COALESCE(max(id), 0) FROM audit
           ON CONFLICT (tenant_id) DO UPDATE
             SET last_audit_id = GREATEST(automation_cursors.last_audit_id, EXCLUDED.last_audit_id)
             WHERE (SELECT count(*) FROM automation_rules) = 1`

	updateRule = `UPDATE automation_rules
           SET name = $1, enabled = $2, trigger_module = $3, trigger_actions = $4::text[],
               conditions = $5::jsonb, actions = $6::jsonb, updated_at = $7
           WHERE id = $8 RETURNING id`

	deleteRule = `DELETE FROM automation_rules WHERE id = $1 RETURNING name`

	insertChannel = `INSERT INTO integration_channels
           (tenant_id, kind, name, target_hint, sealed_config, created_by, created_at)
         VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, name) DO NOTHING RETURNING id`

	channelInUse = `SELECT 1 FROM automation_rules
         WHERE enabled AND actions @> jsonb_build_array(jsonb_build_object('channelId', $1::integer))`

	deleteChannel = `DELETE FROM integration_channels WHERE id = $1 RETURNING name`

	sealedChannel = `SELECT sealed_config FROM integration_channels WHERE id = $1`

	lockCursor = `SELECT last_audit_id FROM automation_cursors FOR UPDATE`

	readEvents = `SELECT a.id, a.ts, a.module, a.record_id, a.action, a.detail, CASE WHEN a.module = 'InteligenciaDigital' THEN a.event_payload ELSE r.payload END AS payload, r.marking
         FROM audit a
         LEFT JOIN module_records r ON r.module = a.module AND r.id = a.record_id
         WHERE a.id > $1 ORDER BY a.id LIMIT $2`

	enabledRules = `SELECT id, name, enabled, trigger_module, trigger_actions, conditions, actions,
  created_by, created_at, updated_at FROM automation_rules WHERE enabled`

	insertRun = `INSERT INTO automation_runs
             (tenant_id, rule_id, audit_id, action_index, kind, event, next_attempt_at, created_at)
           VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5::jsonb, $6, $6)
           ON CONFLICT DO NOTHING RETURNING id`

	advanceCursor = `UPDATE automation_cursors SET last_audit_id = $1`

	// claimDue is the TypeScript claim with one more condition: only runs whose current step
	// this API executes ($4), or whose step is gone (they fail the same way in both APIs).
	claimDue = `WITH due AS (
             SELECT u.id FROM automation_runs u JOIN automation_rules r ON r.id = u.rule_id
             WHERE u.status = 'pending' AND u.next_attempt_at <= $1
               AND (r.actions -> u.action_index IS NULL OR r.actions -> u.action_index ->> 'kind' = ANY($4::text[]))
             ORDER BY u.next_attempt_at, u.id LIMIT $2 FOR UPDATE OF u SKIP LOCKED
           ), claimed AS (
             UPDATE automation_runs u SET attempts = u.attempts + 1, next_attempt_at = $3
             FROM due WHERE u.id = due.id
             RETURNING u.id, u.rule_id, u.attempts, u.event, u.action_index
           )
           SELECT c.id, c.rule_id, r.name, c.attempts, c.event, r.actions -> c.action_index AS step
           FROM claimed c JOIN automation_rules r ON r.id = c.rule_id
           ORDER BY c.id`

	finishDone = `UPDATE automation_runs SET status = 'done', last_error = '', finished_at = $2
           WHERE id = $1`

	finishOther = `UPDATE automation_runs
         SET status = $2, last_error = $3, next_attempt_at = $4,
             finished_at = CASE WHEN $2 = 'failed' THEN $5::timestamptz END
         WHERE id = $1`

	// releaseRun undoes a claim this API cannot execute, so the attempt is not counted.
	releaseRun = `UPDATE automation_runs SET attempts = attempts - 1, next_attempt_at = $2
         WHERE id = $1 AND status = 'pending'`

	insertNotification = `INSERT INTO notifications
           (tenant_id, title, body, module, record_id, marking, rule_id, created_at, run_id)
         VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, run_id) DO UPDATE SET run_id = EXCLUDED.run_id
         RETURNING id`

	markRead = `INSERT INTO notification_reads (tenant_id, notification_id, username, read_at)
         SELECT current_setting('app.tenant_id', true), n.id, $1, $2 FROM notifications n
         WHERE $3::integer[] IS NULL OR n.id = ANY($3::integer[])
         ON CONFLICT DO NOTHING`
)

func (Store) audit(ctx context.Context, q database.Querier, recordID *string, action, detail string, at time.Time) error {
	_, err := q.Exec(ctx, appendAudit, at, domain.AuditModule, recordID, action, domain.PGText(detail))
	return err
}

// AppendAudit is the SendAudit writer: one row of module Automatizaciones.
func (s Store) AppendAudit(ctx context.Context, q database.Querier, e application.AuditEntry) error {
	return s.audit(ctx, q, e.RecordID, e.Action, e.Detail, e.At)
}

// ChannelIDs is the id set of store.channels, which saveRule validates against.
func (s Store) ChannelIDs(ctx context.Context, q database.Querier) (map[int64]bool, error) {
	channels, err := s.Channels(ctx, q)
	if err != nil {
		return nil, err
	}
	ids := make(map[int64]bool, len(channels))
	for _, c := range channels {
		ids[c.ID] = true
	}
	return ids, nil
}

func str(s string) *string { return &s }

// SaveRule is saveRule: refused when another rule has the name, then inserted (starting the
// cursor for the first rule) or updated, and audited.
func (s Store) SaveRule(ctx context.Context, q database.Querier, id *int64, in domain.RuleInput, actor string, at time.Time) (int64, application.SaveError, error) {
	rows, err := q.Query(ctx, duplicateRule, in.Name, id)
	if err != nil {
		return 0, "", err
	}
	duplicate := rows.Next()
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, "", err
	}
	if duplicate {
		return 0, application.RuleDuplicate, nil
	}
	conditions, err := json.Marshal(nonNil(in.Conditions))
	if err != nil {
		return 0, "", err
	}
	steps, err := json.Marshal(in.Steps)
	if err != nil {
		return 0, "", err
	}
	actions := in.Actions
	var saved int64
	if id == nil {
		var newID int32
		if err := q.QueryRow(ctx, insertRule, in.Name, in.Enabled, in.Module, actions, string(conditions), string(steps), at, actor).Scan(&newID); err != nil {
			return 0, "", err
		}
		saved = int64(newID)
		if _, err := q.Exec(ctx, startCursor); err != nil {
			return 0, "", err
		}
	} else {
		var got int32
		err := q.QueryRow(ctx, updateRule, in.Name, in.Enabled, in.Module, actions, string(conditions), string(steps), at, *id).Scan(&got)
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, application.RuleMissing, nil
		}
		if err != nil {
			return 0, "", err
		}
		saved = *id
	}
	action, state := "CREATE", "en pausa"
	if id != nil {
		action = "UPDATE"
	}
	if in.Enabled {
		state = "activa"
	}
	if err := s.audit(ctx, q, str(strconv.FormatInt(saved, 10)), action, "Regla «"+in.Name+"» "+state, at); err != nil {
		return 0, "", err
	}
	return saved, "", nil
}

func nonNil(c []domain.Condition) []domain.Condition {
	if c == nil {
		return []domain.Condition{}
	}
	return c
}

// DeleteRule is deleteRule.
func (s Store) DeleteRule(ctx context.Context, q database.Querier, id int64, at time.Time) (bool, error) {
	var name string
	err := q.QueryRow(ctx, deleteRule, id).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, s.audit(ctx, q, str(strconv.FormatInt(id, 10)), "DELETE", "Regla «"+name+"» eliminada", at)
}

// CreateChannel is createChannel; duplicate is true when the name is taken.
func (s Store) CreateChannel(ctx context.Context, q database.Querier, kind, name, hint, sealed, actor string, at time.Time) (int64, bool, error) {
	var id int32
	err := q.QueryRow(ctx, insertChannel, kind, name, hint, sealed, actor, at).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, true, nil
	}
	if err != nil {
		return 0, false, err
	}
	record := "canal-" + strconv.FormatInt(int64(id), 10)
	return int64(id), false, s.audit(ctx, q, &record, "CREATE", "Canal "+kind+" «"+name+"» hacia "+hint, at)
}

// DeleteChannel is deleteChannel: "in_use", "missing" or "deleted".
func (s Store) DeleteChannel(ctx context.Context, q database.Querier, id int64, at time.Time) (string, error) {
	rows, err := q.Query(ctx, channelInUse, id)
	if err != nil {
		return "", err
	}
	used := rows.Next()
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", err
	}
	if used {
		return "in_use", nil
	}
	var name string
	err = q.QueryRow(ctx, deleteChannel, id).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "missing", nil
	}
	if err != nil {
		return "", err
	}
	record := "canal-" + strconv.FormatInt(id, 10)
	return "deleted", s.audit(ctx, q, &record, "DELETE", "Canal «"+name+"» eliminado", at)
}

// SealedChannel is sealedChannel.
func (Store) SealedChannel(ctx context.Context, q database.Querier, id int64) (string, bool, error) {
	var sealed string
	err := q.QueryRow(ctx, sealedChannel, id).Scan(&sealed)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	return sealed, err == nil, err
}

// MarkRead is markRead; nil ids marks every notification.
func (Store) MarkRead(ctx context.Context, q database.Querier, username string, ids []int64, at time.Time) error {
	var list any
	if ids != nil {
		list = ids
	}
	_, err := q.Exec(ctx, markRead, username, at, list)
	return err
}

// Scan is scan: under the cursor's row lock, the next audit rows matched against the enabled
// rules, one run per step (unique), and the cursor moved over the settled events only.
func (Store) Scan(ctx context.Context, q database.Querier, limit int, at time.Time) (int64, int64, error) {
	var cursor int64
	err := q.QueryRow(ctx, lockCursor).Scan(&cursor)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, err
	}
	events, err := readAuditEvents(ctx, q, cursor, limit)
	if err != nil || len(events) == 0 {
		return 0, 0, err
	}
	rules, err := readEnabledRules(ctx, q)
	if err != nil {
		return 0, 0, err
	}
	var queued int64
	if len(rules) > 0 {
		for _, run := range domain.PlanRuns(events, rules) {
			rows, err := q.Query(ctx, insertRun, run.RuleID, run.AuditID, run.ActionIndex, run.Kind,
				string(StoredEvent(run.Event)), at)
			if err != nil {
				return 0, 0, err
			}
			for rows.Next() {
				queued++
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return 0, 0, err
			}
		}
	}
	settled := Settled(cursor, events, at)
	if settled != cursor {
		if _, err := q.Exec(ctx, advanceCursor, settled); err != nil {
			return 0, 0, err
		}
	}
	return int64(len(events)), queued, nil
}

// Settled is the cursor position after a scan at `at`: the last event, in id order, before the
// first one younger than the settle window.
func Settled(cursor int64, events []domain.Event, at time.Time) int64 {
	horizon := at.UnixMilli() - CursorSettle.Milliseconds()
	settled := cursor
	for _, e := range events {
		if e.At.UnixMilli() > horizon {
			break
		}
		settled = e.AuditID
	}
	return settled
}

func readAuditEvents(ctx context.Context, q database.Querier, cursor int64, limit int) ([]domain.Event, error) {
	rows, err := q.Query(ctx, readEvents, cursor, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Event, error) {
		var (
			e       domain.Event
			ts      time.Time
			detail  *string
			payload []byte
			marking *string
		)
		if err := row.Scan(&e.AuditID, &ts, &e.Module, &e.RecordID, &e.Action, &detail, &payload, &marking); err != nil {
			return e, err
		}
		e.At = domain.JSMillis(ts)
		if detail != nil {
			e.Detail = *detail
		}
		if payload != nil {
			value, err := records.Parse(payload)
			if err != nil {
				return e, err
			}
			if truthy(value) {
				m := "interno"
				if marking != nil {
					m = *marking
				}
				e.Record = &domain.EventRecord{Payload: value, Marking: m}
			}
		}
		return e, nil
	})
}

// truthy is JavaScript truthiness of a decoded JSON value (`row.payload ? … : null`).
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && x == x
	case string:
		return x != ""
	}
	return true
}

func readEnabledRules(ctx context.Context, q database.Querier) ([]domain.Rule, error) {
	rows, err := q.Query(ctx, enabledRules)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Rule, error) {
		var (
			r                    domain.Rule
			id                   int32
			conditions, steps    []byte
			createdBy            string
			createdAt, updatedAt time.Time
		)
		if err := row.Scan(&id, &r.Name, &r.Enabled, &r.Module, &r.Actions, &conditions, &steps,
			&createdBy, &createdAt, &updatedAt); err != nil {
			return r, err
		}
		r.ID = int64(id)
		if err := json.Unmarshal(conditions, &r.Conditions); err != nil {
			return r, err
		}
		return r, json.Unmarshal(steps, &r.Steps)
	})
}

// StoredEvent is toStoredEvent: the event as JSON, its date as an ISO string.
func StoredEvent(e domain.Event) []byte {
	o := records.NewObject()
	o.Set("auditId", float64(e.AuditID))
	o.Set("at", domain.ISOMillis(e.At))
	o.Set("module", e.Module)
	if e.RecordID == nil {
		o.Set("recordId", nil)
	} else {
		o.Set("recordId", *e.RecordID)
	}
	o.Set("action", e.Action)
	o.Set("detail", e.Detail)
	if e.Record == nil {
		o.Set("record", nil)
	} else {
		r := records.NewObject()
		r.Set("payload", e.Record.Payload)
		r.Set("marking", e.Record.Marking)
		o.Set("record", r)
	}
	return []byte(domain.PGText(string(records.Stringify(o))))
}

// storedEvent is the stored JSON of a run's event.
type storedEvent struct {
	AuditID  int64         `json:"auditId"`
	At       string        `json:"at"`
	Module   string        `json:"module"`
	RecordID *string       `json:"recordId"`
	Action   string        `json:"action"`
	Detail   string        `json:"detail"`
	Record   *storedRecord `json:"record"`
}

type storedRecord struct {
	Payload json.RawMessage `json:"payload"`
	Marking string          `json:"marking"`
}

// fromStoredEvent is fromStoredEvent.
func fromStoredEvent(raw []byte) (domain.Event, error) {
	var s storedEvent
	if err := json.Unmarshal(raw, &s); err != nil {
		return domain.Event{}, err
	}
	at, err := time.Parse(time.RFC3339Nano, s.At)
	if err != nil {
		return domain.Event{}, err
	}
	e := domain.Event{AuditID: s.AuditID, At: domain.JSMillis(at), Module: s.Module, RecordID: s.RecordID, Action: s.Action, Detail: s.Detail}
	if s.Record != nil {
		payload, err := records.Parse(s.Record.Payload)
		if err != nil {
			return domain.Event{}, err
		}
		e.Record = &domain.EventRecord{Payload: payload, Marking: s.Record.Marking}
	}
	return e, nil
}

// ClaimDue is claimDue: due runs locked with SKIP LOCKED, their attempt counted and their
// lease set in one statement, with the rule step each one executes.
func (Store) ClaimDue(ctx context.Context, q database.Querier, limit int, at, leaseUntil time.Time, kinds []string) ([]application.ClaimedRun, error) {
	return collectClaimed(q.Query(ctx, claimDue, at, limit, leaseUntil, kinds))
}

func collectClaimed(rows pgx.Rows, err error) ([]application.ClaimedRun, error) {
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (application.ClaimedRun, error) {
		var (
			c                    application.ClaimedRun
			id, ruleID, attempts int32
			event, step          []byte
		)
		if err := row.Scan(&id, &ruleID, &c.RuleName, &attempts, &event, &step); err != nil {
			return c, err
		}
		c.ID, c.RuleID, c.Attempts = int64(id), int64(ruleID), int64(attempts)
		e, err := fromStoredEvent(event)
		if err != nil {
			return c, err
		}
		c.Event = e
		if step != nil && string(step) != "null" {
			var s domain.Step
			if err := json.Unmarshal(step, &s); err != nil {
				return c, err
			}
			c.Step = &s
		}
		return c, nil
	})
}

// FinishRun is finishRun.
func (Store) FinishRun(ctx context.Context, q database.Querier, id int64, o application.RunOutcome, at time.Time) error {
	if o.Status == "done" {
		_, err := q.Exec(ctx, finishDone, id, at)
		return err
	}
	_, err := q.Exec(ctx, finishOther, id, o.Status, domain.PGText(o.Error), o.RetryAt, at)
	return err
}

// ReleaseRun hands a claimed run back without counting the attempt.
func (Store) ReleaseRun(ctx context.Context, q database.Querier, id int64, at time.Time) error {
	_, err := q.Exec(ctx, releaseRun, id, at)
	return err
}

// Notify is notify: one notification per run (unique), its id returned on a repeat too.
func (Store) Notify(ctx context.Context, q database.Querier, n application.NewNotification, at time.Time) (int64, error) {
	var id int32
	err := q.QueryRow(ctx, insertNotification, domain.PGText(n.Title), domain.PGText(n.Body), n.Module, n.RecordID,
		n.Marking, n.RuleID, at, n.RunID).Scan(&id)
	return int64(id), err
}

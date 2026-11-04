// Package application is the read side of apps/api/src/contexts/automation: the rows the store
// returns and their JSON as automation-routes.ts writes it (ruleOut, channelOut, runOut and the
// inbox items). Saving rules and channels, ticks and deliveries stay in TypeScript.
package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// Store reads one tenant's automation rows inside its tenant transaction (forced RLS).
type Store interface {
	Rules(ctx context.Context, q database.Querier) ([]Rule, error)
	Channels(ctx context.Context, q database.Querier) ([]Channel, error)
	Runs(ctx context.Context, q database.Querier, limit int64) ([]Run, error)
	Inbox(ctx context.Context, q database.Querier, username string, limit int64) (Inbox, error)
}

// Rule is StoredRule. Conditions and Steps are the stored JSON elements, written by the
// TypeScript API after validateRule.
type Rule struct {
	ID         int64
	Name       string
	Enabled    bool
	Module     string
	Actions    []string
	Conditions []json.RawMessage
	Steps      []json.RawMessage
	CreatedBy  string
	UpdatedAt  time.Time
}

// Channel is StoredChannel: never the sealed configuration.
type Channel struct {
	ID         int64
	Kind       string
	Name       string
	TargetHint string
	CreatedBy  string
	CreatedAt  time.Time
}

// Run is RunView with its matched event as stored (JSON with an ISO `at`).
type Run struct {
	ID            int64
	RuleID        int64
	RuleName      string
	Kind          string
	Status        string
	Attempts      int64
	LastError     string
	Event         json.RawMessage
	CreatedAt     time.Time
	FinishedAt    *time.Time
	NextAttemptAt time.Time
}

// Notification is NotificationView.
type Notification struct {
	ID        int64
	Title     string
	Body      string
	Module    *string
	RecordID  *string
	CreatedAt time.Time
	Read      bool
}

// Inbox is the user's unread count and latest notifications.
type Inbox struct {
	Unread int64
	Items  []Notification
}

// Marshal is JSON.stringify for these values: '<', '>' and '&' stay as they are, and raw JSON
// elements are compacted.
func Marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

// StepJSON is stepOut: the stored step's fields under the wire names, in its key order. A field
// the step lacks is left out, as JSON.stringify drops undefined.
type StepJSON struct {
	evaluate, notify bool
	title, minimum   json.RawMessage
	channel          json.RawMessage
}

// MarshalJSON writes the variant of stepOut that the step's kind selects.
func (s StepJSON) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	field := func(name string, v json.RawMessage) {
		if len(v) > 0 {
			b.WriteString(`,"` + name + `":`)
			b.Write(v)
		}
	}
	switch {
	case s.evaluate:
		b.WriteString(`{"kind":"evaluate"`)
		field("title", s.title)
		field("minimum_level", s.minimum)
	case s.notify:
		b.WriteString(`{"kind":"notify"`)
		field("title", s.title)
	default:
		b.WriteString(`{"kind":"channel"`)
		field("channel_id", s.channel)
		field("title", s.title)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func stepOut(raw json.RawMessage) StepJSON {
	var step struct {
		Kind         json.RawMessage `json:"kind"`
		Title        json.RawMessage `json:"title"`
		MinimumLevel json.RawMessage `json:"minimumLevel"`
		ChannelID    json.RawMessage `json:"channelId"`
	}
	_ = json.Unmarshal(raw, &step) // a step that is no object has none of these fields
	return StepJSON{
		evaluate: string(step.Kind) == `"evaluate"`, notify: string(step.Kind) == `"notify"`,
		title: step.Title, minimum: step.MinimumLevel, channel: step.ChannelID,
	}
}

// RuleJSON is RuleOut of @sipges/contracts.
type RuleJSON struct {
	ID         int64             `json:"id"`
	Name       string            `json:"name"`
	Enabled    bool              `json:"enabled"`
	Module     string            `json:"module"`
	Actions    []string          `json:"actions"`
	Conditions []json.RawMessage `json:"conditions"`
	Steps      []StepJSON        `json:"steps"`
	CreatedBy  string            `json:"created_by"`
	UpdatedAt  string            `json:"updated_at"`
}

// RuleOut is ruleOut of automation-routes.ts.
func RuleOut(r Rule) RuleJSON {
	out := RuleJSON{
		ID: r.ID, Name: r.Name, Enabled: r.Enabled, Module: r.Module,
		Actions: append([]string{}, r.Actions...), Conditions: append([]json.RawMessage{}, r.Conditions...),
		Steps: make([]StepJSON, 0, len(r.Steps)), CreatedBy: r.CreatedBy, UpdatedAt: domain.ISOSeconds(r.UpdatedAt),
	}
	for _, s := range r.Steps {
		out.Steps = append(out.Steps, stepOut(s))
	}
	return out
}

// ChannelJSON is ChannelOut of @sipges/contracts.
type ChannelJSON struct {
	ID         int64  `json:"id"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	TargetHint string `json:"target_hint"`
	CreatedBy  string `json:"created_by"`
	CreatedAt  string `json:"created_at"`
}

// ChannelOut is channelOut of automation-routes.ts.
func ChannelOut(c Channel) ChannelJSON {
	return ChannelJSON{ID: c.ID, Kind: c.Kind, Name: c.Name, TargetHint: c.TargetHint, CreatedBy: c.CreatedBy,
		CreatedAt: domain.ISOSeconds(c.CreatedAt)}
}

// EventJSON is RunOut['event']. The stored fields pass through as stored; one the event lacks
// is left out, as JSON.stringify drops undefined.
type EventJSON struct {
	AuditID  json.RawMessage `json:"audit_id,omitempty"`
	At       string          `json:"at"`
	Module   json.RawMessage `json:"module,omitempty"`
	RecordID json.RawMessage `json:"record_id,omitempty"`
	Action   json.RawMessage `json:"action,omitempty"`
	Detail   json.RawMessage `json:"detail,omitempty"`
}

// RunJSON is RunOut of @sipges/contracts.
type RunJSON struct {
	ID            int64     `json:"id"`
	RuleID        int64     `json:"rule_id"`
	RuleName      string    `json:"rule_name"`
	Kind          string    `json:"kind"`
	Status        string    `json:"status"`
	Attempts      int64     `json:"attempts"`
	LastError     string    `json:"last_error"`
	Event         EventJSON `json:"event"`
	CreatedAt     string    `json:"created_at"`
	FinishedAt    *string   `json:"finished_at"`
	NextAttemptAt string    `json:"next_attempt_at"`
}

// errEventDate is isoSeconds(new Date(event.at)) throwing on a missing or unreadable date.
var errEventDate = errors.New("automation: stored run event has no valid date")

// RunOut is runOut of automation-routes.ts: a restricted record's event detail is blanked.
func RunOut(r Run) (RunJSON, error) {
	var event struct {
		AuditID  json.RawMessage `json:"auditId"`
		At       *string         `json:"at"`
		Module   json.RawMessage `json:"module"`
		RecordID json.RawMessage `json:"recordId"`
		Action   json.RawMessage `json:"action"`
		Detail   json.RawMessage `json:"detail"`
		Record   *struct {
			Marking json.RawMessage `json:"marking"`
		} `json:"record"`
	}
	if err := json.Unmarshal(r.Event, &event); err != nil || event.At == nil {
		return RunJSON{}, errEventDate
	}
	eventAt, err := time.Parse(time.RFC3339Nano, *event.At)
	if err != nil {
		return RunJSON{}, errEventDate
	}
	detail := event.Detail
	if event.Record != nil && string(event.Record.Marking) == `"restringido"` {
		detail = json.RawMessage(`""`)
	}
	out := RunJSON{
		ID: r.ID, RuleID: r.RuleID, RuleName: r.RuleName, Kind: r.Kind, Status: r.Status, Attempts: r.Attempts,
		LastError: r.LastError,
		Event: EventJSON{AuditID: event.AuditID, At: domain.ISOSeconds(eventAt), Module: event.Module,
			RecordID: event.RecordID, Action: event.Action, Detail: detail},
		CreatedAt: domain.ISOSeconds(r.CreatedAt), NextAttemptAt: domain.ISOSeconds(r.NextAttemptAt),
	}
	if r.FinishedAt != nil {
		finished := domain.ISOSeconds(*r.FinishedAt)
		out.FinishedAt = &finished
	}
	return out, nil
}

// RunsOut maps runs in order.
func RunsOut(runs []Run) ([]RunJSON, error) {
	out := make([]RunJSON, 0, len(runs))
	for _, r := range runs {
		j, err := RunOut(r)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, nil
}

// OverviewJSON is AutomationOverview of @sipges/contracts.
type OverviewJSON struct {
	Sources   []domain.Source `json:"sources"`
	Actions   []string        `json:"actions"`
	Operators []string        `json:"operators"`
	Rules     []RuleJSON      `json:"rules"`
	Channels  []ChannelJSON   `json:"channels"`
	Runs      []RunJSON       `json:"runs"`
}

// OverviewRuns is the run count GET /system/automations shows.
const OverviewRuns = 50

// Overview is GET /system/automations over the tenant's rules, channels and latest runs.
func Overview(rules []Rule, channels []Channel, runs []Run) (OverviewJSON, error) {
	out := OverviewJSON{
		Sources: domain.Sources(), Actions: append([]string{}, domain.EventActions...),
		Operators: append([]string{}, domain.ConditionOps...),
		Rules:     make([]RuleJSON, 0, len(rules)), Channels: make([]ChannelJSON, 0, len(channels)),
	}
	for _, r := range rules {
		out.Rules = append(out.Rules, RuleOut(r))
	}
	for _, c := range channels {
		out.Channels = append(out.Channels, ChannelOut(c))
	}
	var err error
	out.Runs, err = RunsOut(runs)
	return out, err
}

// LinkJSON is a notification's link to a record screen.
type LinkJSON struct {
	Module string `json:"module"`
	ID     string `json:"id"`
}

// NotificationJSON is one item of NotificationInbox.
type NotificationJSON struct {
	ID        int64     `json:"id"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	Module    *string   `json:"module"`
	RecordID  *string   `json:"record_id"`
	Href      *string   `json:"href,omitempty"`
	Link      *LinkJSON `json:"link"`
	CreatedAt string    `json:"created_at"`
	Read      bool      `json:"read"`
}

// InboxJSON is NotificationInbox of @sipges/contracts.
type InboxJSON struct {
	Unread int64              `json:"unread"`
	Items  []NotificationJSON `json:"items"`
}

// InboxOut is the GET /system/notifications body: digital alerts open their review screen and
// record modules link to the record.
func InboxOut(in Inbox) InboxJSON {
	out := InboxJSON{Unread: in.Unread, Items: make([]NotificationJSON, 0, len(in.Items))}
	for _, n := range in.Items {
		item := NotificationJSON{ID: n.ID, Title: n.Title, Body: n.Body, Module: n.Module, RecordID: n.RecordID,
			CreatedAt: domain.ISOSeconds(n.CreatedAt), Read: n.Read}
		hasRecord := n.RecordID != nil && *n.RecordID != ""
		if n.Module != nil && *n.Module == "InteligenciaDigital" && hasRecord {
			href := "/inteligencia-redes?alert=" + domain.EncodeURIComponent(*n.RecordID)
			item.Href = &href
		}
		if n.Module != nil && hasRecord {
			if slug, ok := domain.Slug(*n.Module); ok {
				item.Link = &LinkJSON{Module: slug, ID: *n.RecordID}
			}
		}
		out.Items = append(out.Items, item)
	}
	return out
}

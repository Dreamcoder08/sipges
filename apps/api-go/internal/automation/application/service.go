package application

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	situations "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// The write side and the tick of apps/api/src/contexts/automation/application/automation-service.ts.

// Batches and lease of automation-service.ts.
const (
	ScanBatch     = 500
	DeliveryBatch = 50
	LeaseSeconds  = 120
)

// DefaultExecutionBudget is the tick budget the TypeScript composition root passes (8000 ms).
const DefaultExecutionBudget = 8 * time.Second

// ClaimedRun is ClaimedRun: a claimed run with the rule step it executes (nil when the rule
// changed since).
type ClaimedRun struct {
	ID       int64
	RuleID   int64
	RuleName string
	Attempts int64
	Event    domain.Event
	Step     *domain.Step
}

// RunOutcome is the outcome finishRun records: done, pending (retry at RetryAt) or failed.
type RunOutcome struct {
	Status  string
	Error   string
	RetryAt time.Time
}

// NewNotification is NewNotification.
type NewNotification struct {
	RunID    int64
	Title    string
	Body     string
	Module   string
	RecordID *string
	Marking  string
	RuleID   int64
}

// AuditEntry is one audit row this context writes (module Automatizaciones).
type AuditEntry struct {
	RecordID *string
	Action   string
	Detail   string
	At       time.Time
}

// SaveError is why a rule was not saved.
type SaveError string

// Save errors besides the domain's RuleError.
const (
	RuleMissing   SaveError = "missing"
	RuleDuplicate SaveError = "duplicate"
)

// Writes is the SQL store's write and runtime side; every call runs inside one tenant
// transaction (the Querier), as each call of the TypeScript store opens its own.
type Writes interface {
	ChannelIDs(ctx context.Context, q database.Querier) (map[int64]bool, error)
	SaveRule(ctx context.Context, q database.Querier, id *int64, in domain.RuleInput, actor string, at time.Time) (int64, SaveError, error)
	DeleteRule(ctx context.Context, q database.Querier, id int64, at time.Time) (bool, error)
	CreateChannel(ctx context.Context, q database.Querier, kind, name, hint, sealed, actor string, at time.Time) (int64, bool, error)
	DeleteChannel(ctx context.Context, q database.Querier, id int64, at time.Time) (string, error)
	SealedChannel(ctx context.Context, q database.Querier, id int64) (string, bool, error)
	MarkRead(ctx context.Context, q database.Querier, username string, ids []int64, at time.Time) error
	Scan(ctx context.Context, q database.Querier, limit int, at time.Time) (scanned, queued int64, err error)
	ClaimDue(ctx context.Context, q database.Querier, limit int, at, leaseUntil time.Time, kinds []string) ([]ClaimedRun, error)
	FinishRun(ctx context.Context, q database.Querier, id int64, outcome RunOutcome, at time.Time) error
	ReleaseRun(ctx context.Context, q database.Querier, id int64, at time.Time) error
	Notify(ctx context.Context, q database.Querier, n NewNotification, at time.Time) (int64, error)
	AppendAudit(ctx context.Context, q database.Querier, e AuditEntry) error
}

// PushOutbox queues browser pushes for a notification (push_deliveries).
type PushOutbox interface {
	Enqueue(ctx context.Context, tenantID string, notificationID int64, restricted bool, payload PushPayload, at time.Time) error
}

// PushPayload is PushPayload.
type PushPayload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
}

// Message is OutboundMessage: Event is the JSON object spread into a webhook body.
type Message struct {
	ID       string
	Title    string
	Text     string
	TenantID string
	At       time.Time
	Event    *records.Object
}

// Sender is ChannelSender.
type Sender interface {
	Send(ctx context.Context, config domain.ChannelConfig, m Message) error
}

// Sealer is SecretSealer (internal/platform/secrets.Cipher).
type Sealer interface {
	Seal(plaintext string) (string, error)
	Open(sealed string) (string, error)
}

// InTenant runs fn in one tenant transaction as the context's actor (database.WithTenant).
type InTenant func(ctx context.Context, tenantID string, fn func(context.Context, database.Querier) error) error

// ErrNoSealer is returned when a channel must be sealed or opened and SIPGES_DATA_KEY is not set.
var ErrNoSealer = errors.New("automation: SIPGES_DATA_KEY is not configured")

// Service is createAutomationService for the parts the Go API runs.
type Service struct {
	Store    Writes
	InTenant InTenant
	// Push queues browser pushes; nil queues none.
	Push PushOutbox
	// Subscriptions holds the browsers' push subscriptions.
	Subscriptions PushStore
	// PushSender sends browser pushes; nil means no VAPID keys, which leaves push off.
	PushSender PushSender
	// Deliveries claims and settles the queued pushes; nil delivers none.
	Deliveries PushDeliveries
	Sender     Sender
	// Sealer seals channel settings; nil means channel runs are left for the TypeScript API
	// and channel writes fail.
	Sealer Sealer
	Now    func() time.Time
	// Monotonic measures the execution budget (performance.now); nil means the process clock.
	Monotonic func() time.Duration
	// ExecutionBudget bounds one tenant's tick; zero means DefaultExecutionBudget.
	ExecutionBudget time.Duration
	Logger          *slog.Logger
}

func (s Service) now() time.Time {
	if s.Now != nil {
		return domain.JSMillis(s.Now())
	}
	return domain.JSMillis(time.Now())
}

func (s Service) mono() time.Duration {
	if s.Monotonic != nil {
		return s.Monotonic()
	}
	return time.Since(processStart)
}

func tx[T any](ctx context.Context, s Service, tenantID string, fn func(context.Context, database.Querier) (T, error)) (T, error) {
	var out T
	err := s.InTenant(ctx, tenantID, func(ctx context.Context, q database.Querier) error {
		var err error
		out, err = fn(ctx, q)
		return err
	})
	return out, err
}

// ExecutableKinds are the step kinds this API runs: `evaluate` needs the narrative evaluation
// of the intelligence context (createAlert), which is not ported, and `channel` needs the data
// key. Runs of other kinds are never claimed here, so the TypeScript API delivers them.
func (s Service) ExecutableKinds() []string {
	if s.Sealer == nil {
		return []string{"notify"}
	}
	return []string{"notify", "channel"}
}

// audited is audited: best effort by design. The send already happened (or failed), so a
// failing audit write is logged and swallowed; failing the run would repeat the message.
func (s Service) audited(ctx context.Context, tenantID, detail string) {
	s.auditedAs(ctx, tenantID, "CHANNEL_SEND", detail)
}

// auditedAs is audited with its action: CHANNEL_SEND or PUSH_SEND.
func (s Service) auditedAs(ctx context.Context, tenantID, action, detail string) {
	err := s.InTenant(ctx, tenantID, func(ctx context.Context, q database.Querier) error {
		return s.Store.AppendAudit(ctx, q, AuditEntry{Action: action, Detail: detail, At: s.now()})
	})
	if err != nil && s.Logger != nil {
		s.Logger.LogAttrs(ctx, slog.LevelError, "automation send audit failed",
			slog.String("action", action), slog.String("error", "Error"))
	}
}

var whitespaceRun = regexp.MustCompile(`[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)

// errorText is errorText: the message with whitespace runs as one space, cut to 300 units.
// A PostgreSQL error contributes its message, as postgres.js reports it.
func errorText(err error) string {
	msg := err.Error()
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		msg = pgErr.Message
	}
	return domain.Slice16(whitespaceRun.ReplaceAllString(msg, " "), 300)
}

// eventURL is eventUrl: where a push notification opens.
func eventURL(e domain.Event) string {
	if e.Module == "InteligenciaDigital" && e.RecordID != nil && *e.RecordID != "" {
		return "/inteligencia-redes?alert=" + domain.EncodeURIComponent(*e.RecordID)
	}
	slug, ok := domain.Slug(e.Module)
	if ok && e.RecordID != nil && *e.RecordID != "" {
		return "/objeto/" + domain.EncodeURIComponent(slug) + "/" + domain.EncodeURIComponent(*e.RecordID)
	}
	return "/"
}

// EventBody is eventBody: the webhook body's event, the record only when not restricted.
func EventBody(tenantID string, e domain.Event) *records.Object {
	o := records.NewObject()
	o.Set("type", "sipges."+situations.LowerJS(e.Module)+"."+situations.LowerJS(e.Action))
	o.Set("tenant", tenantID)
	o.Set("audit_id", float64(e.AuditID))
	o.Set("at", domain.ISOMillis(e.At))
	o.Set("module", e.Module)
	o.Set("record_id", optional(e.RecordID))
	o.Set("action", e.Action)
	restricted := e.Record != nil && e.Record.Marking == "restringido"
	if restricted {
		o.Set("detail", "")
	} else {
		o.Set("detail", e.Detail)
	}
	if e.Record == nil {
		o.Set("marking", nil)
		o.Set("record", nil)
	} else {
		o.Set("marking", e.Record.Marking)
		if restricted {
			o.Set("record", nil)
		} else {
			o.Set("record", e.Record.Payload)
		}
	}
	return o
}

func optional(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// messageID is `msg_${tenantId.replace(/[^A-Za-z0-9]/g, '_')}_${run.id}`, per UTF-16 unit.
func messageID(tenantID string, runID int64) string {
	units := domain.Units(tenantID)
	b := make([]byte, len(units))
	for i, u := range units {
		if u < 0x80 && (u >= 'A' && u <= 'Z' || u >= 'a' && u <= 'z' || u >= '0' && u <= '9') {
			b[i] = byte(u)
		} else {
			b[i] = '_'
		}
	}
	return "msg_" + string(b) + "_" + strconv.FormatInt(runID, 10)
}

func (s Service) openChannel(ctx context.Context, tenantID string, id int64) (*domain.ChannelConfig, error) {
	var (
		sealed string
		found  bool
	)
	err := s.InTenant(ctx, tenantID, func(ctx context.Context, q database.Querier) error {
		var err error
		sealed, found, err = s.Store.SealedChannel(ctx, q, id)
		return err
	})
	if err != nil || !found {
		return nil, err
	}
	if s.Sealer == nil {
		return nil, ErrNoSealer
	}
	plain, err := s.Sealer.Open(sealed)
	if err != nil {
		return nil, err
	}
	var config domain.ChannelConfig
	if err := json.Unmarshal([]byte(plain), &config); err != nil {
		return nil, err
	}
	return &config, nil
}

// errStepMissing and errChannelMissing are the TypeScript errors, recorded as last_error.
//
//nolint:staticcheck // ST1005: the TypeScript texts, stored as last_error and shown to administrators
var (
	errStepMissing    = errors.New("La regla ya no tiene esta acción")
	errChannelMissing = errors.New("El canal ya no existe")
	errNotExecutable  = errors.New("automation: step kind not executed by this API")
)

func (s Service) execute(ctx context.Context, tenantID string, run ClaimedRun) error {
	step, e := run.Step, run.Event
	if step == nil {
		return errStepMissing
	}
	title := domain.RenderTitle(step.Title, e)
	text := domain.DescribeEvent(e)
	switch step.Kind {
	case "notify":
		marking := "interno"
		if e.Record != nil {
			marking = e.Record.Marking
		}
		id, err := tx(ctx, s, tenantID, func(ctx context.Context, q database.Querier) (int64, error) {
			return s.Store.Notify(ctx, q, NewNotification{RunID: run.ID, Title: title, Body: text, Module: e.Module,
				RecordID: e.RecordID, Marking: marking, RuleID: run.RuleID}, s.now())
		})
		if err != nil {
			return err
		}
		if s.Push != nil {
			return s.Push.Enqueue(ctx, tenantID, id, e.Record != nil && e.Record.Marking == "restringido",
				PushPayload{Title: title, Body: text, URL: eventURL(e)}, s.now())
		}
		return nil
	case "channel":
		if s.Sealer == nil {
			return errNotExecutable
		}
		config, err := s.openChannel(ctx, tenantID, step.ChannelID)
		if err != nil {
			return err
		}
		if config == nil {
			return errChannelMissing
		}
		detail := "Envío " + config.Kind + " · regla " + strconv.FormatInt(run.RuleID, 10) + " · canal " +
			strconv.FormatInt(step.ChannelID, 10) + " · evento " + strconv.FormatInt(e.AuditID, 10)
		err = s.Sender.Send(ctx, *config, Message{ID: messageID(tenantID, run.ID), Title: title, Text: text,
			TenantID: tenantID, At: s.now(), Event: EventBody(tenantID, e)})
		if err != nil {
			s.audited(ctx, tenantID, detail+" · fallido")
			return err
		}
		s.audited(ctx, tenantID, detail+" · enviado")
		return nil
	}
	return errNotExecutable
}

type delivery struct{ delivered, retrying, failed int64 }

func (s Service) deliver(ctx context.Context, tenantID string, deadline time.Duration) (delivery, error) {
	var out delivery
	for count := 0; count < DeliveryBatch && s.mono() < deadline; count++ {
		now := s.now()
		claimed, err := tx(ctx, s, tenantID, func(ctx context.Context, q database.Querier) ([]ClaimedRun, error) {
			return s.Store.ClaimDue(ctx, q, 1, now, now.Add(LeaseSeconds*time.Second), s.ExecutableKinds())
		})
		if err != nil {
			return out, err
		}
		if len(claimed) == 0 {
			break
		}
		for _, run := range claimed {
			execErr := s.execute(ctx, tenantID, run)
			if errors.Is(execErr, errNotExecutable) {
				// The rule changed between the claim's filter and its step: hand it back.
				if err := s.InTenant(ctx, tenantID, func(ctx context.Context, q database.Querier) error {
					return s.Store.ReleaseRun(ctx, q, run.ID, s.now())
				}); err != nil {
					return out, err
				}
				continue
			}
			outcome := RunOutcome{Status: "done"}
			at := s.now()
			if execErr != nil {
				delay, retry := int64(0), false
				if run.Step != nil {
					delay, retry = domain.RetryDelayMinutes(run.Attempts)
				}
				outcome = RunOutcome{Status: "failed", Error: errorText(execErr), RetryAt: at}
				if retry {
					outcome = RunOutcome{Status: "pending", Error: errorText(execErr), RetryAt: at.Add(time.Duration(delay) * time.Minute)}
				}
			}
			if err := s.InTenant(ctx, tenantID, func(ctx context.Context, q database.Querier) error {
				return s.Store.FinishRun(ctx, q, run.ID, outcome, at)
			}); err != nil {
				return out, err
			}
			switch outcome.Status {
			case "done":
				out.delivered++
			case "pending":
				out.retrying++
			default:
				out.failed++
			}
		}
	}
	return out, nil
}

// Tick is tickTenant: up to three rounds of scanning new audit rows and delivering due runs.
// No in-flight tick is shared, and concurrent ticks of one tenant are safe: the scan locks the
// cursor and runs are claimed with SKIP LOCKED, so each event is queued and delivered once.
// The queued browser pushes go out last, with what remains of the budget.
func (s Service) Tick(ctx context.Context, tenantID string) (TickReport, error) {
	budget := s.ExecutionBudget
	if budget <= 0 {
		budget = DefaultExecutionBudget
	}
	deadline := s.mono() + budget
	report := TickReport{Tenants: 1}
	for round := 0; round < 3 && s.mono() < deadline; round++ {
		var scanned, queued int64
		err := s.InTenant(ctx, tenantID, func(ctx context.Context, q database.Querier) error {
			var err error
			scanned, queued, err = s.Store.Scan(ctx, q, ScanBatch, s.now())
			return err
		})
		if err != nil {
			return report, err
		}
		sent, err := s.deliver(ctx, tenantID, deadline)
		if err != nil {
			return report, err
		}
		report.Scanned += scanned
		report.Queued += queued
		report.Delivered += sent.delivered
		report.Retrying += sent.retrying
		report.Failed += sent.failed
		if scanned == 0 && sent.delivered == 0 {
			break
		}
	}
	if err := s.deliverPush(ctx, tenantID, deadline); err != nil {
		return report, err
	}
	return report, nil
}

// SaveRule is saveRule: validated against the tenant's channels, then saved and audited.
func (s Service) SaveRule(ctx context.Context, tenantID string, id *int64, in domain.RuleInput, actor string) (int64, string, error) {
	channels, err := tx(ctx, s, tenantID, func(ctx context.Context, q database.Querier) (map[int64]bool, error) {
		return s.Store.ChannelIDs(ctx, q)
	})
	if err != nil {
		return 0, "", err
	}
	if invalid := domain.ValidateRule(in, domain.KnownModules(), channels); invalid != "" {
		return 0, string(invalid), nil
	}
	type saved struct {
		id  int64
		bad SaveError
	}
	out, err := tx(ctx, s, tenantID, func(ctx context.Context, q database.Querier) (saved, error) {
		savedID, bad, err := s.Store.SaveRule(ctx, q, id, in, actor, s.now())
		return saved{savedID, bad}, err
	})
	return out.id, string(out.bad), err
}

// DeleteRule is deleteRule.
func (s Service) DeleteRule(ctx context.Context, tenantID string, id int64) (bool, error) {
	return tx(ctx, s, tenantID, func(ctx context.Context, q database.Querier) (bool, error) {
		return s.Store.DeleteRule(ctx, q, id, s.now())
	})
}

// CreateChannel is createChannel: validated, sealed, saved and audited.
func (s Service) CreateChannel(ctx context.Context, tenantID, kind, name string, settings map[string]domain.Setting, actor string) (int64, string, error) {
	config, hint, bad := domain.ValidateChannel(kind, settings)
	if bad != "" {
		return 0, string(bad), nil
	}
	if s.Sealer == nil {
		return 0, "", ErrNoSealer
	}
	plain, err := json.Marshal(config) //nolint:gosec // G117: sealed on the next line, never stored or logged in clear
	if err != nil {
		return 0, "", err
	}
	sealed, err := s.Sealer.Seal(string(plain))
	if err != nil {
		return 0, "", err
	}
	type created struct {
		id  int64
		dup bool
	}
	out, err := tx(ctx, s, tenantID, func(ctx context.Context, q database.Querier) (created, error) {
		id, dup, err := s.Store.CreateChannel(ctx, q, kind, domain.PGText(strings.TrimFunc(name, isSpace)),
			domain.PGText(hint), sealed, actor, s.now())
		return created{id, dup}, err
	})
	if err != nil {
		return 0, "", err
	}
	if out.dup {
		return 0, string(RuleDuplicate), nil
	}
	return out.id, "", nil
}

// DeleteChannel is deleteChannel: "in_use", "missing" or "deleted".
func (s Service) DeleteChannel(ctx context.Context, tenantID string, id int64) (string, error) {
	return tx(ctx, s, tenantID, func(ctx context.Context, q database.Querier) (string, error) {
		return s.Store.DeleteChannel(ctx, q, id, s.now())
	})
}

// TestChannel is testChannel: a message right away; the error text goes back to the
// administrator. ok is false with the text when the channel is missing or the send failed.
func (s Service) TestChannel(ctx context.Context, tenantID string, id int64) (string, bool, error) {
	config, err := s.openChannel(ctx, tenantID, id)
	if err != nil {
		return "", false, err
	}
	if config == nil {
		return "Canal no encontrado", false, nil
	}
	detail := "Prueba de canal " + config.Kind + " · canal " + strconv.FormatInt(id, 10)
	now := s.now()
	event := records.NewObject()
	event.Set("type", "sipges.test")
	event.Set("tenant", tenantID)
	err = s.Sender.Send(ctx, *config, Message{
		ID:       "msg_test_" + strconv.FormatInt(id, 10) + "_" + strconv.FormatInt(now.UnixMilli(), 10),
		Title:    "Prueba de SIPGES",
		Text:     "Este canal recibirá los avisos de las automatizaciones de SIPGES.",
		TenantID: tenantID,
		At:       now,
		Event:    event,
	})
	if err != nil {
		s.audited(ctx, tenantID, detail+" · fallido")
		return errorText(err), false, nil
	}
	s.audited(ctx, tenantID, detail+" · enviado")
	return "", true, nil
}

// MarkRead is markRead: the listed notifications, or all of them when ids is nil.
func (s Service) MarkRead(ctx context.Context, tenantID, username string, ids []int64) error {
	return s.InTenant(ctx, tenantID, func(ctx context.Context, q database.Querier) error {
		return s.Store.MarkRead(ctx, q, username, ids, s.now())
	})
}

func isSpace(r rune) bool { return situations.IsJSSpace(r) }

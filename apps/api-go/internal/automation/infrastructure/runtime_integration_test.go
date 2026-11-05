//nolint:misspell,unparam // Spanish module names; helpers keep the tenant explicit.
package infrastructure_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/secrets"
)

// The runtime against a migrated synthetic PostgreSQL: the settle-window cursor, commits out of
// id order, concurrent ticks, a delivery that crashed mid-run, and the runs this API leaves to
// TypeScript. Each test uses a project of its own; every row is synthetic.

var adminURL = os.Getenv(dbtest.EnvAdminURL)

func scratchPool(t *testing.T, tenants ...string) *pgxpool.Pool {
	t.Helper()
	if adminURL == "" {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	ctx := t.Context()
	s, err := dbtest.NewScratch(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Drop(context.Background()) })
	pool, err := pgxpool.New(ctx, s.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	for _, tenant := range tenants {
		company, project, _ := cut(tenant)
		if _, err := pool.Exec(ctx, `INSERT INTO tenants (company_id, project_id, label) VALUES ($1, $2, $2)`, company, project); err != nil {
			t.Fatal(err)
		}
	}
	return pool
}

func cut(tenant string) (string, string, bool) {
	for i := range tenant {
		if tenant[i] == '/' {
			return tenant[:i], tenant[i+1:], true
		}
	}
	return tenant, "", false
}

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *clock) Add(d time.Duration) { c.mu.Lock(); c.now = c.now.Add(d); c.mu.Unlock() }

type recordingSender struct {
	mu   sync.Mutex
	sent []application.Message
	fail error
}

func (r *recordingSender) Send(_ context.Context, _ domain.ChannelConfig, m application.Message) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sent = append(r.sent, m)
	return r.fail
}

func service(pool *pgxpool.Pool, c *clock) application.Service {
	return application.Service{
		Store: infrastructure.Store{},
		InTenant: func(ctx context.Context, tenantID string, fn func(context.Context, database.Querier) error) error {
			_, err := database.WithTenant(application.WorkerContext(ctx), pool, tenantID, func(ctx context.Context, q database.Querier) (struct{}, error) {
				return struct{}{}, fn(ctx, q)
			})
			return err
		},
		Push:   infrastructure.PushOutbox{DB: pool},
		Sender: &recordingSender{},
		Now:    c.Now,
	}
}

// audit appends an audit row as the records context does, in its own committed transaction.
func audit(t *testing.T, pool *pgxpool.Pool, tenant string, at time.Time, module, recordID, action string) int64 {
	t.Helper()
	id, err := database.WithTenant(t.Context(), pool, tenant, func(ctx context.Context, q database.Querier) (int64, error) {
		var id int64
		err := q.QueryRow(ctx, `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
			VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, 'sintético') RETURNING id`,
			at, module, recordID, action).Scan(&id)
		return id, err
	})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// saveRule saves a rule as it was three minutes before the service's clock, so the rule's own
// audit row (module Automatizaciones, never matched) is settled when the tests scan.
func saveRule(t *testing.T, s application.Service, tenant string, in domain.RuleInput) int64 {
	t.Helper()
	now := s.Now
	s.Now = func() time.Time { return now().Add(-3 * time.Minute) }
	id, bad, err := s.SaveRule(t.Context(), tenant, nil, in, "admin-sintetico")
	if err != nil || bad != "" {
		t.Fatalf("save rule: %q %v", bad, err)
	}
	return id
}

func notifyRule(name, module string) domain.RuleInput {
	return domain.RuleInput{Name: name, Enabled: true, Module: module, Actions: []string{"CREATE"},
		Conditions: []domain.Condition{}, Steps: []domain.Step{{Kind: "notify", Title: "Aviso {id}"}}}
}

func scalar(t *testing.T, pool *pgxpool.Pool, tenant, sql string, args ...any) int64 {
	t.Helper()
	n, err := database.WithTenant(application.WorkerContext(t.Context()), pool, tenant, func(ctx context.Context, q database.Querier) (int64, error) {
		var n int64
		err := q.QueryRow(ctx, sql, args...).Scan(&n)
		return n, err
	})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func scan(t *testing.T, s application.Service, tenant string, at time.Time) (int64, int64) {
	t.Helper()
	var scanned, queued int64
	err := s.InTenant(t.Context(), tenant, func(ctx context.Context, q database.Querier) error {
		var err error
		scanned, queued, err = s.Store.Scan(ctx, q, application.ScanBatch, at)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return scanned, queued
}

const tenant = "SIPGES/PRJ-SECHURA"

func TestTheCursorPassesOnlySettledEventsAndRescansQueueNothingTwice(t *testing.T) {
	pool := scratchPool(t, tenant)
	c := &clock{now: time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)}
	s := service(pool, c)
	saveRule(t, s, tenant, notifyRule("Eventos nuevos", "Eventos"))
	old := audit(t, pool, tenant, c.now.Add(-2*time.Minute), "Eventos", "EV-1", "CREATE")
	fresh := audit(t, pool, tenant, c.now.Add(-10*time.Second), "Eventos", "EV-2", "CREATE")

	// The rule's own audit row is read too and matches nothing.
	if scanned, queued := scan(t, s, tenant, c.now); scanned != 3 || queued != 2 {
		t.Fatalf("first scan: %d scanned, %d queued", scanned, queued)
	}
	cursor := scalar(t, pool, tenant, `SELECT last_audit_id FROM automation_cursors`)
	if cursor != old {
		t.Fatalf("cursor %d, want %d: the event inside the window must be read again", cursor, old)
	}
	if scanned, queued := scan(t, s, tenant, c.now); scanned != 1 || queued != 0 {
		t.Fatalf("rescan: %d scanned, %d queued; the run is unique per rule, audit id and step", scanned, queued)
	}
	if scanned, queued := scan(t, s, tenant, c.now.Add(51*time.Second)); scanned != 1 || queued != 0 {
		t.Fatalf("settled scan: %d scanned, %d queued", scanned, queued)
	}
	if cursor := scalar(t, pool, tenant, `SELECT last_audit_id FROM automation_cursors`); cursor != fresh {
		t.Fatalf("cursor %d, want %d once the event is older than the window", cursor, fresh)
	}
	if n := scalar(t, pool, tenant, `SELECT count(*) FROM automation_runs`); n != 2 {
		t.Fatalf("%d runs, want 2", n)
	}
}

func TestAnEventCommittedAfterAHigherIdIsNotLost(t *testing.T) {
	pool := scratchPool(t, tenant)
	c := &clock{now: time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)}
	s := service(pool, c)
	saveRule(t, s, tenant, notifyRule("Eventos nuevos", "Eventos"))

	// A slow writer takes the lower id and has not committed when a faster one commits a higher.
	slow, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = slow.Rollback(context.Background()) }()
	if err := database.EnterTenant(t.Context(), slow, tenant); err != nil {
		t.Fatal(err)
	}
	var low int64
	if err := slow.QueryRow(t.Context(), `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
		VALUES (current_setting('app.tenant_id', true), $1, 'Eventos', 'EV-LENTO', 'CREATE', 'sintético') RETURNING id`,
		c.now.Add(-time.Second)).Scan(&low); err != nil {
		t.Fatal(err)
	}
	high := audit(t, pool, tenant, c.now, "Eventos", "EV-RAPIDO", "CREATE")
	if high <= low {
		t.Fatalf("ids %d then %d", low, high)
	}
	if scanned, queued := scan(t, s, tenant, c.now.Add(time.Second)); scanned != 2 || queued != 1 {
		t.Fatalf("scan before the slow commit: %d scanned, %d queued", scanned, queued)
	}
	if err := slow.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	if scanned, queued := scan(t, s, tenant, c.now.Add(2*time.Second)); scanned != 2 || queued != 1 {
		// The settled rule row was passed; the fresh event stayed inside the window, so the
		// cursor is still below the lower id and the scan finds it.
		t.Fatalf("scan after the slow commit: %d scanned, %d queued (the lower id must be found)", scanned, queued)
	}
	if n := scalar(t, pool, tenant, `SELECT count(DISTINCT audit_id) FROM automation_runs WHERE audit_id IN ($1, $2)`, low, high); n != 2 {
		t.Fatalf("%d of the two events have runs", n)
	}
}

func TestConcurrentTicksQueueAndDeliverEachRunOnce(t *testing.T) {
	pool := scratchPool(t, tenant)
	c := &clock{now: time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)}
	s := service(pool, c)
	saveRule(t, s, tenant, notifyRule("Eventos nuevos", "Eventos"))
	const events = 30
	for i := range events {
		audit(t, pool, tenant, c.now.Add(-5*time.Minute), "Eventos", fmt.Sprintf("EV-%d", i), "CREATE")
	}
	var (
		wg              sync.WaitGroup
		mu              sync.Mutex
		queued, deliver int64
		errs            []error
	)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 3 {
				r, err := s.Tick(context.Background(), tenant)
				mu.Lock()
				queued += r.Queued
				deliver += r.Delivered
				if err != nil {
					errs = append(errs, err)
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if len(errs) > 0 {
		t.Fatal(errors.Join(errs...))
	}
	if queued != events || deliver != events {
		t.Fatalf("ticks reported %d queued and %d delivered, want %d each", queued, deliver, events)
	}
	if n := scalar(t, pool, tenant, `SELECT count(*) FROM automation_runs WHERE status = 'done' AND attempts = 1`); n != events {
		t.Fatalf("%d runs done on their first attempt, want %d", n, events)
	}
	if n := scalar(t, pool, tenant, `SELECT count(*) FROM notifications`); n != events {
		t.Fatalf("%d notifications, want %d", n, events)
	}
}

func TestADeliveryThatCrashedIsRetriedAfterItsLeaseAndNotifiesOnce(t *testing.T) {
	pool := scratchPool(t, tenant)
	c := &clock{now: time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)}
	s := service(pool, c)
	saveRule(t, s, tenant, notifyRule("Eventos nuevos", "Eventos"))
	audit(t, pool, tenant, c.now.Add(-5*time.Minute), "Eventos", "EV-1", "CREATE")
	scan(t, s, tenant, c.now)

	// A worker claims the run, writes the notification and dies before finishing the run.
	var claimed []application.ClaimedRun
	err := s.InTenant(t.Context(), tenant, func(ctx context.Context, q database.Querier) error {
		var err error
		claimed, err = s.Store.ClaimDue(ctx, q, 1, c.now, c.now.Add(application.LeaseSeconds*time.Second), s.ExecutableKinds())
		if err != nil || len(claimed) != 1 {
			return fmt.Errorf("claim: %d runs: %w", len(claimed), err)
		}
		_, err = s.Store.Notify(ctx, q, application.NewNotification{RunID: claimed[0].ID, Title: "Aviso EV-1",
			Body: "CREATE en Eventos EV-1", Module: "Eventos", Marking: "interno", RuleID: claimed[0].RuleID}, c.now)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if r, err := s.Tick(t.Context(), tenant); err != nil || r.Delivered != 0 {
		t.Fatalf("tick during the lease delivered %d (%v)", r.Delivered, err)
	}
	c.Add(application.LeaseSeconds*time.Second + time.Second)
	if r, err := s.Tick(t.Context(), tenant); err != nil || r.Delivered != 1 {
		t.Fatalf("tick after the lease delivered %d (%v)", r.Delivered, err)
	}
	if n := scalar(t, pool, tenant, `SELECT count(*) FROM notifications`); n != 1 {
		t.Fatalf("%d notifications, want one per run", n)
	}
	if n := scalar(t, pool, tenant, `SELECT attempts FROM automation_runs WHERE status = 'done'`); n != 2 {
		t.Fatalf("attempts %d, want 2", n)
	}
}

func TestRunsThisAPICannotExecuteAreLeftUntouched(t *testing.T) {
	pool := scratchPool(t, tenant)
	c := &clock{now: time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)}
	s := service(pool, c)
	saveRule(t, s, tenant, domain.RuleInput{Name: "Evaluar narrativas", Enabled: true, Module: "Narrativas",
		Actions: []string{"CREATE"}, Steps: []domain.Step{{Kind: "evaluate", Title: "Evaluar", MinimumLevel: "Media"}}})
	audit(t, pool, tenant, c.now.Add(-5*time.Minute), "Narrativas", "NA-1", "CREATE")
	r, err := s.Tick(t.Context(), tenant)
	if err != nil || r.Queued != 1 || r.Delivered+r.Retrying+r.Failed != 0 {
		t.Fatalf("tick %+v (%v): the evaluate run must be queued and left alone", r, err)
	}
	if n := scalar(t, pool, tenant, `SELECT count(*) FROM automation_runs WHERE status = 'pending' AND attempts = 0`); n != 1 {
		t.Fatal("the evaluate run was claimed")
	}
}

func TestChannelRunsWaitForTheDataKeyThenSendAndAudit(t *testing.T) {
	pool := scratchPool(t, tenant)
	c := &clock{now: time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)}
	s := service(pool, c)
	cipher, err := secrets.NewCipher(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	withKey := s
	withKey.Sealer = cipher
	sender := &recordingSender{}
	withKey.Sender = sender
	channel, bad, err := withKey.CreateChannel(t.Context(), tenant, "slack", "Canal sintético",
		map[string]domain.Setting{"url": {Text: "https://hooks.slack.com/services/sintetico"}}, "admin-sintetico")
	if err != nil || bad != "" {
		t.Fatalf("create channel: %q %v", bad, err)
	}
	saveRule(t, s, tenant, domain.RuleInput{Name: "Al canal", Enabled: true, Module: "Eventos", Actions: []string{"CREATE"},
		Steps: []domain.Step{{Kind: "channel", ChannelID: channel, Title: "Evento {id}"}}})
	audit(t, pool, tenant, c.now.Add(-5*time.Minute), "Eventos", "EV-7", "CREATE")

	if r, err := s.Tick(t.Context(), tenant); err != nil || r.Delivered != 0 {
		t.Fatalf("without the key: %+v (%v)", r, err)
	}
	if n := scalar(t, pool, tenant, `SELECT attempts FROM automation_runs`); n != 0 {
		t.Fatal("a channel run was claimed without the data key")
	}
	if r, err := withKey.Tick(t.Context(), tenant); err != nil || r.Delivered != 1 {
		t.Fatalf("with the key: %+v (%v)", r, err)
	}
	if len(sender.sent) != 1 || sender.sent[0].Title != "Evento EV-7" {
		t.Fatalf("sent %+v", sender.sent)
	}
	if n := scalar(t, pool, tenant, `SELECT count(*) FROM audit WHERE module = 'Automatizaciones' AND action = 'CHANNEL_SEND' AND detail LIKE '%· enviado'`); n != 1 {
		t.Fatalf("%d send audits", n)
	}
	// The run's own audit row (module Automatizaciones) never matches a rule: no loop.
	if r, err := withKey.Tick(t.Context(), tenant); err != nil || r.Queued != 0 {
		t.Fatalf("second tick %+v (%v)", r, err)
	}
}

func TestTheRuntimeRecordsEachAttemptOnTheCursor(t *testing.T) {
	pool := scratchPool(t, tenant, "ACME/NORTE")
	c := &clock{now: time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)}
	s := service(pool, c)
	saveRule(t, s, tenant, notifyRule("Eventos nuevos", "Eventos"))
	audit(t, pool, tenant, c.now.Add(-5*time.Minute), "Eventos", "EV-1", "CREATE")
	store := infrastructure.RuntimeStore{DB: pool}
	rt := &application.Runtime{Store: store, Tick: s.Tick, Now: c.Now}
	report, err := rt.Scheduled(application.WorkerContext(t.Context()))
	if err != nil || report.Delivered != 1 || report.Tenants != 1 {
		t.Fatalf("scheduled %+v (%v)", report, err)
	}
	state, err := store.State(t.Context(), tenant)
	if err != nil || state == nil || state.Status != "completed" || state.Source != application.SourceCron ||
		state.Report == nil || state.Report.Delivered != 1 {
		t.Fatalf("state %+v (%v)", state, err)
	}
	// A project without a cursor is not visited by the cron, as in TypeScript.
	if state, err := store.State(t.Context(), "ACME/NORTE"); err != nil || state != nil {
		t.Fatalf("norte state %+v (%v)", state, err)
	}
	_ = pgx.ErrNoRows
}

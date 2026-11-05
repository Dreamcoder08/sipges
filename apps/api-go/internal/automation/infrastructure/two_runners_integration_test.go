package infrastructure_test

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"sync"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/secrets"
)

// What happens if both APIs run the cron (docs/deployment/go-automation-cron.md): two Go
// schedules and a third runner claiming with TypeScript's own statement, on one database.

const typeScriptStore = "../../../../api/src/contexts/automation/infrastructure/sql-automation-store.ts"

var typeScriptClaim = regexp.MustCompile("(?s)`(WITH due AS \\(.*?)`")

// claimingLikeTypeScript claims with the statement apps/api runs, read from its source so it cannot
// drift from what this test proves.
type claimingLikeTypeScript struct {
	infrastructure.Store
	sql string
}

func (s claimingLikeTypeScript) ClaimDue(ctx context.Context, q database.Querier, limit int, at, leaseUntil time.Time, _ []string) ([]application.ClaimedRun, error) {
	return infrastructure.ClaimWith(ctx, q, s.sql, at, limit, leaseUntil)
}

// countingSender stands for Slack, Teams, Discord and Telegram: none of them deduplicates.
type countingSender struct {
	mu    sync.Mutex
	sends map[string]int
}

func (c *countingSender) Send(ctx context.Context, _ domain.ChannelConfig, m application.Message) error {
	select {
	case <-time.After(time.Millisecond): // long enough for another runner to try the same run
	case <-ctx.Done():
		return ctx.Err()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sends[m.ID]++
	return nil
}

func TestBothAPIsRunningDeliverEachMessageOnce(t *testing.T) {
	source, err := os.ReadFile(typeScriptStore)
	if err != nil {
		t.Fatal(err)
	}
	found := typeScriptClaim.FindSubmatch(source)
	if found == nil {
		t.Fatal("TypeScript's claim statement was not found")
	}
	pool := scratchPool(t, tenant)
	c := &clock{now: time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)}
	cipher, err := secrets.NewCipher(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	sender := &countingSender{sends: map[string]int{}}
	goService := service(pool, c)
	goService.Sealer, goService.Sender = cipher, sender
	typeScript := goService
	typeScript.Store = claimingLikeTypeScript{sql: string(found[1])}

	channel, bad, err := goService.CreateChannel(t.Context(), tenant, "slack", "Canal sintético",
		map[string]domain.Setting{"url": {Text: "https://hooks.slack.com/services/sintetico"}}, "admin-sintetico")
	if err != nil || bad != "" {
		t.Fatalf("create channel: %q %v", bad, err)
	}
	saveRule(t, goService, tenant, notifyRule("Aviso interno", "Eventos"))
	saveRule(t, goService, tenant, domain.RuleInput{Name: "Al canal", Enabled: true, Module: "Eventos", Actions: []string{"CREATE"},
		Steps: []domain.Step{{Kind: "channel", ChannelID: channel, Title: "Evento {id}"}}})
	const settled, fresh = 40, 10
	for i := range settled {
		audit(t, pool, tenant, c.now.Add(-5*time.Minute), "Eventos", fmt.Sprintf("EV-%d", i), "CREATE")
	}

	stop, cancel := context.WithCancel(context.Background())
	defer cancel()
	runners := make([]*application.Runtime, 0, 3)
	for _, s := range []application.Service{goService, goService, typeScript} {
		rt := &application.Runtime{Store: infrastructure.RuntimeStore{DB: pool}, Tick: s.Tick, Now: c.Now,
			Background: func() context.Context { return application.WorkerContext(context.Background()) }}
		rt.StartSchedule(stop, application.Schedule{Interval: 2 * time.Millisecond,
			OnError: func(err error) { t.Errorf("tick: %v", err) }})
		runners = append(runners, rt)
	}
	// Events keep arriving while the runners work, inside the settle window: every scan reads
	// them again, and only the unique run keeps them from being queued twice.
	for i := range fresh {
		audit(t, pool, tenant, c.now, "Eventos", fmt.Sprintf("EV-FRESCO-%d", i), "CREATE")
	}
	const events, runs = settled + fresh, 2 * (settled + fresh)
	deadline := time.Now().Add(30 * time.Second)
	for scalar(t, pool, tenant, `SELECT count(*) FROM automation_runs WHERE status = 'done'`) != runs {
		if time.Now().After(deadline) {
			t.Fatalf("%d of %d runs done", scalar(t, pool, tenant, `SELECT count(*) FROM automation_runs WHERE status = 'done'`), runs)
		}
		time.Sleep(20 * time.Millisecond) //nolint:forbidigo // waiting for the schedules
	}
	cancel()
	for _, rt := range runners {
		if err := rt.Drain(t.Context()); err != nil {
			t.Fatal(err)
		}
	}

	sender.mu.Lock()
	defer sender.mu.Unlock()
	if len(sender.sends) != events {
		t.Fatalf("%d messages sent, want %d", len(sender.sends), events)
	}
	for id, n := range sender.sends {
		if n != 1 {
			t.Fatalf("%s sent %d times", id, n)
		}
	}
	if n := scalar(t, pool, tenant, `SELECT count(*) FROM automation_runs`); n != runs {
		t.Fatalf("%d runs, want %d: unique per rule, event and step", n, runs)
	}
	if n := scalar(t, pool, tenant, `SELECT count(*) FROM automation_runs WHERE attempts <> 1`); n != 0 {
		t.Fatalf("%d runs claimed more than once", n)
	}
	if n := scalar(t, pool, tenant, `SELECT count(*) FROM notifications`); n != events {
		t.Fatalf("%d notifications, want %d", n, events)
	}
	if n := scalar(t, pool, tenant, `SELECT count(*) FROM audit WHERE action = 'CHANNEL_SEND'`); n != events {
		t.Fatalf("%d send audits, want %d", n, events)
	}

	// Once the window passes, the cursor reaches the newest row and nothing is queued again.
	c.Add(2 * time.Minute)
	if r, err := goService.Tick(t.Context(), tenant); err != nil || r.Queued != 0 || r.Delivered != 0 {
		t.Fatalf("tick after the window: %+v (%v)", r, err)
	}
	if cursor, newest := scalar(t, pool, tenant, `SELECT last_audit_id FROM automation_cursors`), scalar(t, pool, tenant, `SELECT max(id) FROM audit`); cursor != newest {
		t.Fatalf("cursor %d, newest audit row %d", cursor, newest)
	}
}

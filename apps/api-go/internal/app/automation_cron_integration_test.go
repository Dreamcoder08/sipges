package app_test

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// The polling a cron tick does before its rules, composed as the flag composes it, against a
// synthetic PostgreSQL. Every row and feed item is synthetic.

const cronTenant = "SIPGES/PRJ-CRON"

func cronPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	adminURL := os.Getenv(dbtest.EnvAdminURL)
	if adminURL == "" {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	s, err := dbtest.NewScratch(t.Context(), adminURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Drop(context.Background()) })
	pool, err := pgxpool.New(t.Context(), s.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO tenants (company_id, project_id, label) VALUES ('SIPGES', 'PRJ-CRON', 'Cron');
		INSERT INTO automation_cursors (tenant_id, last_audit_id) VALUES ('SIPGES/PRJ-CRON', 0);
		INSERT INTO media_feeds (tenant_id, name, url, authorization_note, updated_by, updated_at)
		  VALUES ('SIPGES/PRJ-CRON', 'Fuente sintética', 'https://fuente.example.org/rss', 'Pública', 'admin', now());
		INSERT INTO source_import_settings (tenant_id, source_id, enabled, query, authorization_note, updated_by, updated_at)
		  VALUES ('SIPGES/PRJ-CRON', 'defensoria', true, 'sintetico', 'Autorizada', 'admin', now());`); err != nil {
		t.Fatal(err)
	}
	return pool
}

// sources stand for the public feed and the Defensoría connector.
type sources struct {
	feedReads, officialReads   atomic.Int64
	feedPanics, officialPanics bool
}

func (s *sources) Read(context.Context, string) ([]domain.FeedItem, error) {
	s.feedReads.Add(1)
	if s.feedPanics {
		panic("synthetic feed")
	}
	return []domain.FeedItem{{Key: "item-1", Title: "Noticia sintética", Link: "https://fuente.example.org/1"}}, nil
}

func (s *sources) Preview(context.Context, string) ([]domain.OfficialPost, error) {
	s.officialReads.Add(1)
	if s.officialPanics {
		panic("synthetic connector")
	}
	return nil, nil
}

func (s *sources) Get(context.Context, int) (domain.OfficialPost, error) {
	return domain.OfficialPost{}, errors.New("not used")
}

func noTick(context.Context, string) (application.TickReport, error) {
	return application.TickReport{Tenants: 1}, nil
}

func narratives(t *testing.T, pool *pgxpool.Pool) int64 {
	t.Helper()
	return inTenant(t, pool, `SELECT count(*) FROM module_records WHERE id LIKE 'SRC-RSS-%'`)
}

func feedErrors(t *testing.T, pool *pgxpool.Pool) int64 {
	t.Helper()
	return inTenant(t, pool, `SELECT count(*) FROM media_feeds WHERE last_poll_error <> ''`)
}

func inTenant(t *testing.T, pool *pgxpool.Pool, sql string) int64 {
	t.Helper()
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(t.Context(), `SELECT set_config('app.tenant_id', $1, true)`, cronTenant); err != nil {
		t.Fatal(err)
	}
	var n int64
	if err := tx.QueryRow(t.Context(), sql).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestTwoRunnersPollEachSourceOnce(t *testing.T) {
	pool := cronPool(t)
	gateway := &sources{}
	var wg sync.WaitGroup
	for range 8 {
		rt := app.CronRunner(pool, time.Minute, gateway, gateway, noTick)
		wg.Go(func() {
			if _, err := rt.Scheduled(application.WorkerContext(context.Background())); err != nil {
				t.Errorf("scheduled: %v", err)
			}
		})
	}
	wg.Wait()
	if n := gateway.feedReads.Load(); n != 1 {
		t.Fatalf("the feed was read %d times", n)
	}
	if n := gateway.officialReads.Load(); n != 1 {
		t.Fatalf("the connector was read %d times", n)
	}
	if n := narratives(t, pool); n != 1 {
		t.Fatalf("%d narratives, want one", n)
	}
}

func TestOnlyACronTickPolls(t *testing.T) {
	pool := cronPool(t)
	gateway := &sources{}
	rt := app.CronRunner(pool, time.Minute, gateway, gateway, noTick)
	if _, err := rt.Run(application.WorkerContext(t.Context()), cronTenant, application.SourceEvent); err != nil {
		t.Fatal(err)
	}
	if n := gateway.feedReads.Load() + gateway.officialReads.Load(); n != 0 {
		t.Fatalf("an event tick polled %d times", n)
	}
}

func TestWithoutTheFlagNoTickPolls(t *testing.T) {
	pool := cronPool(t)
	gateway := &sources{}
	rt := app.CronRunner(pool, 0, gateway, gateway, noTick)
	if _, err := rt.Scheduled(application.WorkerContext(t.Context())); err != nil {
		t.Fatal(err)
	}
	if n := gateway.feedReads.Load() + gateway.officialReads.Load(); n != 0 {
		t.Fatalf("polled %d times with the flag off", n)
	}
}

func TestAPanickingConnectorFailsTheAttemptNotTheProcess(t *testing.T) {
	pool := cronPool(t)
	gateway := &sources{officialPanics: true}
	ticked := false
	rt := app.CronRunner(pool, time.Minute, gateway, gateway, func(context.Context, string) (application.TickReport, error) {
		ticked = true
		return application.TickReport{}, nil
	})
	_, err := rt.Scheduled(application.WorkerContext(t.Context()))
	if err == nil || !strings.Contains(err.Error(), "panicked") {
		t.Fatalf("scheduled: %v", err)
	}
	if !ticked {
		t.Fatal("the rules did not run after the polling failed")
	}
	if n := gateway.feedReads.Load(); n != 1 {
		t.Fatalf("the feed was read %d times: one source must not stop the other", n)
	}
}

func TestAPanickingFeedIsThatFeedsErrorNotTheProcess(t *testing.T) {
	pool := cronPool(t)
	gateway := &sources{feedPanics: true}
	rt := app.CronRunner(pool, time.Minute, gateway, gateway, noTick)
	if _, err := rt.Scheduled(application.WorkerContext(t.Context())); err != nil {
		t.Fatalf("scheduled: %v", err)
	}
	if n := feedErrors(t, pool); n != 1 {
		t.Fatalf("%d feeds report an error, want the one that panicked", n)
	}
	if n := gateway.officialReads.Load(); n != 1 {
		t.Fatalf("the connector was read %d times: one source must not stop the other", n)
	}
}

func TestTheFlagRefusesToStartWithoutTheDataKey(t *testing.T) {
	pool := cronPool(t)
	t.Setenv("SIPGES_DATA_KEY", "") // restored when the test ends
	if err := os.Unsetenv("SIPGES_DATA_KEY"); err != nil {
		t.Fatal(err)
	}
	_, err := app.NewHandler(pool, app.Options{Logger: slog.New(slog.DiscardHandler), AutomationInterval: time.Minute})
	if err == nil || !strings.Contains(err.Error(), "SIPGES_GO_AUTOMATION_CRON requires SIPGES_DATA_KEY") {
		t.Fatalf("handler: %v", err)
	}
}

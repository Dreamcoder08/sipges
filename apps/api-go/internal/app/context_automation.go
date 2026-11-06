package app

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	automationhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/http"
	automationsql "github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/infrastructure"
	integration "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/application"
	integrationsql "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/secrets"
	situations "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// automationEnv reads the automation settings; tests replace it.
var automationEnv secrets.Lookup = os.LookupEnv

// DrainBackground waits for the automation ticks running on pool, until ctx ends. The process
// calls it after the server stopped and before closing the pool.
func DrainBackground(ctx context.Context, pool *pgxpool.Pool) error {
	automationMu.Lock()
	m := automationModules[pool]
	automationMu.Unlock()
	if m == nil {
		return nil
	}
	return m.runtime.Drain(ctx)
}

// automation is the context's composition: its routes and the wakeup middleware share one
// runtime per pool, so a write's wakeup and the cron see the same running ticks.
type automation struct {
	service application.Service
	runtime *application.Runtime
	// cron is the secret the cron route accepts: empty, so it refuses every caller, unless
	// this API is the runner.
	cron     string
	interval time.Duration
	// cronConfigured says a cron secret exists, even while cron stays empty above.
	cronConfigured bool
}

var (
	automationMu      sync.Mutex
	automationModules = map[*pgxpool.Pool]*automation{}
)

func automationModule(d Deps) (*automation, error) {
	automationMu.Lock()
	defer automationMu.Unlock()
	if m, ok := automationModules[d.Pool]; ok {
		return m, nil
	}
	key, previous, configured, err := secrets.DataKeys(automationEnv)
	if err != nil {
		return nil, err
	}
	cron, err := cronSecret(automationEnv)
	if err != nil {
		return nil, err
	}
	service := application.Service{
		Store: automationsql.Store{},
		InTenant: func(ctx context.Context, tenantID string, fn func(context.Context, database.Querier) error) error {
			_, err := database.WithTenant(ctx, d.Pool, tenantID, func(ctx context.Context, q database.Querier) (struct{}, error) {
				return struct{}{}, fn(ctx, q)
			})
			return err
		},
		Push:            automationsql.PushOutbox{DB: d.Pool},
		Sender:          automationsql.Sender{},
		Now:             d.Now,
		ExecutionBudget: application.DefaultExecutionBudget,
		Logger:          d.Logger,
	}
	service.Evaluate = narrativeEvaluator(d)
	service, err = withPush(service, d.Pool)
	if err != nil {
		return nil, err
	}
	if d.AutomationInterval > 0 && !configured {
		// Channel runs would wait forever for a TypeScript tick that may no longer come.
		return nil, errors.New("SIPGES_GO_AUTOMATION_CRON requires SIPGES_DATA_KEY")
	}
	cronConfigured := cron != ""
	if d.AutomationInterval == 0 {
		cron = ""
	}
	if configured {
		cipher, err := secrets.NewCipher(key, nonEmpty(previous)...)
		if err != nil {
			return nil, err
		}
		service.Sealer = cipher
	}
	m := &automation{service: service, cron: cron, interval: d.AutomationInterval, cronConfigured: cronConfigured}
	m.runtime = automationRuntime(d, service, integrationsql.RSS{}, integrationsql.Official{})
	automationModules[d.Pool] = m
	return m, nil
}

// automationRuntime composes the runtime. Polling is wired only when this API is the runner:
// without the flag no cron tick reaches it, because the route refuses and no schedule starts.
func automationRuntime(d Deps, service application.Service, feeds integration.FeedGateway, official integration.OfficialGateway) *application.Runtime {
	rt := &application.Runtime{
		Store: automationsql.RuntimeStore{DB: d.Pool},
		Tick:  service.Tick,
		Now:   d.Now,
		// A tick outlives the request that woke it: it runs as the worker, bounded so a hung
		// connection cannot hold it forever (claimed runs are retried after their lease).
		Background:  func() context.Context { return application.WorkerContext(context.Background()) },
		TaskTimeout: 5 * time.Minute,
		OnError: func(error) {
			if d.Logger != nil {
				d.Logger.LogAttrs(context.Background(), slog.LevelError, "automation_processing_failed")
			}
		},
	}
	if d.AutomationInterval > 0 {
		media, sources := integrationPolling(d, feeds, official)
		polling := integration.Runtime{Sources: sources, Media: media}
		rt.BeforeTick = func(ctx context.Context, tenantID string, source application.RuntimeSource) error {
			if source != application.SourceCron {
				return nil
			}
			return polling.BeforeTick(ctx, tenantID)
		}
	}
	return rt
}

func nonEmpty(key []byte) [][]byte {
	if key == nil {
		return nil
	}
	return [][]byte{key}
}

// cronSecret is the cron part of parseAutomation (apps/api/src/platform/config.ts):
// SIPGES_CRON_SECRET, else CRON_SECRET, trimmed, at least 24 characters.
func cronSecret(lookup secrets.Lookup) (string, error) {
	value, _ := lookup("SIPGES_CRON_SECRET")
	if value == "" {
		value, _ = lookup("CRON_SECRET")
	}
	value = situations.TrimJS(value)
	if value != "" && len(utf16.Encode([]rune(value))) < 24 {
		return "", errors.New("SIPGES_CRON_SECRET (or CRON_SECRET) must be at least 24 characters")
	}
	return value, nil
}

// cronSchedule is the expression a Worker's Cron Trigger fires on; nil on any other server.
func cronSchedule(lookup secrets.Lookup) *string {
	if value, ok := lookup("SIPGES_CRON_SCHEDULE"); ok && value != "" {
		return &value
	}
	return nil
}

func init() {
	registerContext("automation", func(d Deps) (func(*http.ServeMux), error) {
		m, err := automationModule(d)
		if err != nil {
			return nil, err
		}
		options := automationhttp.Options{DB: d.Pool, Store: automationsql.Store{}, Logger: d.Logger}
		writes := automationhttp.WriteOptions{Service: m.service, Runtime: m.runtime, CronSecret: m.cron, Logger: d.Logger}
		return func(mux *http.ServeMux) {
			automationhttp.Routes(mux, options)
			automationhttp.WriteRoutes(mux, writes)
			automationhttp.PushRoutes(mux, writes)
			automationhttp.RuntimeRoutes(mux, writes, automationhttp.RuntimeInfo{
				CronConfigured: m.cronConfigured,
				CronSchedule:   cronSchedule(automationEnv),
				IntervalMS:     m.interval.Milliseconds(),
				Latest:         automationsql.RuntimeStore{DB: d.Pool}.State,
			})
		}, nil
	})
	registerMiddleware("automation", func(d Deps) (httpx.Middleware, error) {
		m, err := automationModule(d)
		if err != nil {
			return nil, err
		}
		return automationhttp.Wakeup(m.runtime), nil
	})
}

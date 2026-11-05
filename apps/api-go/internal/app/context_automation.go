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
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/secrets"
	situations "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// automationEnv reads the automation settings; tests replace it.
var automationEnv secrets.Lookup = os.LookupEnv

// automation is the context's composition: its routes and the wakeup middleware share one
// runtime per pool, so a write's wakeup and the cron see the same running ticks.
type automation struct {
	service application.Service
	runtime *application.Runtime
	cron    string
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
	if configured {
		cipher, err := secrets.NewCipher(key, nonEmpty(previous)...)
		if err != nil {
			return nil, err
		}
		service.Sealer = cipher
	}
	m := &automation{service: service, cron: cron}
	m.runtime = &application.Runtime{
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
	automationModules[d.Pool] = m
	return m, nil
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

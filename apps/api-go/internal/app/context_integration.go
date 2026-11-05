package app

import (
	"net/http"
	"time"

	integration "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/application"
	integrationhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/http"
	integrationsql "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/infrastructure"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
	recordssql "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/infrastructure"
)

func init() {
	registerContext("integration", func(d Deps) (func(*http.ServeMux), error) {
		service := integration.Service{Store: integrationsql.Store{DB: d.Pool}}
		runtime := integrationRuntime(d, integrationsql.RSS{}, integrationsql.Official{})
		return func(mux *http.ServeMux) {
			integrationhttp.Routes(mux, service, d.Logger)
			integrationhttp.RegisterRuntime(mux, runtime)
		}, nil
	})
}

// integrationRuntime composes the integration runtime as compose.ts does: API keys, ingest
// receipts over the records context's create, the media monitor and the Defensoría connector,
// both importing narratives through the same importer.
func integrationRuntime(d Deps, feeds integration.FeedGateway, official integration.OfficialGateway) integrationhttp.Runtime {
	now := d.Now
	if now == nil {
		now = time.Now
	}
	clock := integration.Clock(now)
	store := recordssql.Records{DB: d.Pool}
	importer := integration.Importer{Store: store, Clock: clock}
	return integrationhttp.Runtime{
		Keys: integration.Keys{Store: integrationsql.Keys{DB: d.Pool}, Clock: clock},
		Ingest: integration.Ingest{
			Records:  records.Writes{Store: store, Now: now, RandomHex: randomHexUpper},
			Receipts: integrationsql.Receipts{DB: d.Pool},
			Clock:    clock,
		},
		Media: integration.Media{
			Feeds: integrationsql.Feeds{DB: d.Pool}, Gateway: feeds, Importer: importer, Clock: clock,
		},
		Sources: integration.Sources{
			Gateway: official, Settings: integrationsql.Settings{DB: d.Pool}, Importer: importer, Clock: clock,
		},
		Log: d.Logger,
	}
}

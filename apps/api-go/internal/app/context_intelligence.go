package app

import (
	"errors"
	"net/http"
	"os"

	intelligence "github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/application"
	intelligencehttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/http"
	intelligencesql "github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/config"
)

func init() {
	registerContext("intelligence", func(d Deps) (func(*http.ServeMux), error) {
		ollama, err := config.LoadOllama(os.LookupEnv)
		if err != nil {
			return nil, err
		}
		embedder, err := intelligencesql.NewOllama(ollama.BaseURL, ollama.Model)
		if err != nil {
			return nil, err
		}
		probe := intelligence.NewEmbedderProbe(embedder, externalAISwitch{d.Pool}, d.Now)
		settings := intelligencehttp.EmbedderSettings{Configured: ollama.Configured, SemanticSearch: ollama.SemanticSearch}
		service := intelligence.Service{Store: intelligencesql.Alerts{DB: d.Pool}}
		// Without SIPGES_DATA_KEY there is no guard, so a text goes to a local model or nowhere.
		semantic := &intelligence.Semantic{Embedder: embedder}
		guard, err := egressGuard(d)
		switch {
		case err == nil:
			semantic.Egress = guard
		case !errors.Is(err, config.ErrNoDataKey):
			return nil, err
		}
		return func(mux *http.ServeMux) {
			intelligencehttp.Routes(mux, service, d.Logger)
			intelligencehttp.EmbedderRoute(mux, probe, settings, d.Logger)
			// The engines are read when the routes mount, as the analytics context does.
			writes := intelligence.Writes{
				Engine:     d.Engines.Analytics,
				Narratives: intelligencesql.Narratives{DB: d.Pool},
				Decisions:  intelligencesql.Decisions{DB: d.Pool},
				Now:        d.Now,
			}
			intelligencehttp.WriteRoutes(mux, writes, d.Logger)
			semantic.Text = writes
			intelligencehttp.SemanticRoute(mux, semantic, d.Logger)
		}, nil
	})
}

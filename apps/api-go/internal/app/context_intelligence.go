package app

import (
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
		return func(mux *http.ServeMux) {
			intelligencehttp.Routes(mux, service, d.Logger)
			intelligencehttp.EmbedderRoute(mux, probe, settings, d.Logger)
			// The engines are read when the routes mount, as the analytics context does.
			intelligencehttp.WriteRoutes(mux, intelligence.Writes{
				Engine:     d.Engines.Analytics,
				Narratives: intelligencesql.Narratives{DB: d.Pool},
				Decisions:  intelligencesql.Decisions{DB: d.Pool},
				Now:        d.Now,
			}, d.Logger)
		}, nil
	})
}

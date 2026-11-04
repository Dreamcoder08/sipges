package app

import (
	"net/http"

	intelligence "github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/application"
	intelligencehttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/http"
	intelligencesql "github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/infrastructure"
)

func init() {
	registerContext("intelligence", func(d Deps) (func(*http.ServeMux), error) {
		service := intelligence.Service{Store: intelligencesql.Alerts{DB: d.Pool}}
		return func(mux *http.ServeMux) {
			intelligencehttp.Routes(mux, service, d.Logger)
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

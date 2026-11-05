package app

import (
	"net/http"

	ontologyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/http"
)

func init() {
	registerContext("ontology", func(d Deps) (func(*http.ServeMux), error) {
		return func(mux *http.ServeMux) {
			ontologyhttp.Register(mux, ontologyhttp.Deps{DB: d.Pool, Logger: d.Logger, Now: d.Now})
		}, nil
	})
}

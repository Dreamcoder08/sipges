package app

import (
	"net/http"

	indicatorshttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/indicators/http"
)

func init() {
	registerContext("indicators", func(d Deps) (func(*http.ServeMux), error) {
		return func(mux *http.ServeMux) {
			indicatorshttp.Register(mux, indicatorshttp.Deps{Pool: d.Pool, Engine: d.Engines.Indicators, Logger: d.Logger, Now: d.Now})
		}, nil
	})
}

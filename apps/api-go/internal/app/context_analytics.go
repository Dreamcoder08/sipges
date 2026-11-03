package app

import (
	"net/http"

	analyticshttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/analytics/http"
)

func init() {
	registerContext("analytics", func(d Deps) (func(*http.ServeMux), error) {
		return func(mux *http.ServeMux) {
			analyticshttp.Register(mux, analyticshttp.Deps{Pool: d.Pool, Engine: d.Engines.Analytics, Logger: d.Logger, Now: d.Now})
		}, nil
	})
}

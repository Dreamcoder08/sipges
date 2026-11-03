package app

import (
	"net/http"

	situationshttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/http"
	situationssql "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/infrastructure"
)

func init() {
	registerContext("situations", func(d Deps) (func(*http.ServeMux), error) {
		options := situationshttp.Options{DB: d.Pool, Store: situationssql.Store{}, Now: d.Now, Logger: d.Logger}
		return func(mux *http.ServeMux) { situationshttp.Routes(mux, options) }, nil
	})
}

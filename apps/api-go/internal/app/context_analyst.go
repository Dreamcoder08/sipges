package app

import (
	"net/http"

	analysthttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/http"
)

func init() {
	registerContext("analyst", func(d Deps) (func(*http.ServeMux), error) {
		options := analysthttp.Options{DB: d.Pool, Now: d.Now, Logger: d.Logger}
		return func(mux *http.ServeMux) { analysthttp.Routes(mux, options) }, nil
	})
}

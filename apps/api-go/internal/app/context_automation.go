package app

import (
	"net/http"

	automationhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/http"
	automationsql "github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/infrastructure"
)

func init() {
	registerContext("automation", func(d Deps) (func(*http.ServeMux), error) {
		options := automationhttp.Options{DB: d.Pool, Store: automationsql.Store{}, Logger: d.Logger}
		return func(mux *http.ServeMux) { automationhttp.Routes(mux, options) }, nil
	})
}

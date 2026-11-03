package app

import (
	"net/http"

	managementhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/management/http"
)

func init() {
	registerContext("management", func(d Deps) (func(*http.ServeMux), error) {
		return func(mux *http.ServeMux) {
			managementhttp.Register(mux, managementhttp.Deps{Pool: d.Pool, Logger: d.Logger, Now: d.Now})
		}, nil
	})
}

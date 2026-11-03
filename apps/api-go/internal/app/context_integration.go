package app

import (
	"net/http"

	integration "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/application"
	integrationhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/http"
	integrationsql "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/infrastructure"
)

func init() {
	registerContext("integration", func(d Deps) (func(*http.ServeMux), error) {
		service := integration.Service{Store: integrationsql.Store{DB: d.Pool}}
		return func(mux *http.ServeMux) { integrationhttp.Routes(mux, service, d.Logger) }, nil
	})
}

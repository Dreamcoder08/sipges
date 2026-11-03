package app

import (
	"net/http"

	prevention "github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/application"
	preventionhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/http"
	preventionsql "github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/infrastructure"
)

func init() {
	registerContext("prevention", func(d Deps) (func(*http.ServeMux), error) {
		service := prevention.Service{Store: preventionsql.Actions{DB: d.Pool}, Now: d.Now}
		return func(mux *http.ServeMux) { preventionhttp.Routes(mux, service, d.Logger) }, nil
	})
}

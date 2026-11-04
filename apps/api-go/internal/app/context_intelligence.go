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
		return func(mux *http.ServeMux) { intelligencehttp.Routes(mux, service, d.Logger) }, nil
	})
}

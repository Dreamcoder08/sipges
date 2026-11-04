package app

import (
	"net/http"

	documents "github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/application"
	documentshttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/http"
	documentssql "github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/infrastructure"
)

func init() {
	registerContext("documents", func(d Deps) (func(*http.ServeMux), error) {
		service := documents.Service{Store: documentssql.Reviews{DB: d.Pool}}
		return func(mux *http.ServeMux) { documentshttp.Routes(mux, service, d.Logger) }, nil
	})
}

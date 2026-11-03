package app

import (
	"net/http"

	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
	recordshttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/http"
	recordssql "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/infrastructure"
)

func init() {
	registerContext("records", func(d Deps) (func(*http.ServeMux), error) {
		service := records.Service{Store: recordssql.Records{DB: d.Pool}}
		return func(mux *http.ServeMux) { recordshttp.Register(mux, service, d.Logger) }, nil
	})
}

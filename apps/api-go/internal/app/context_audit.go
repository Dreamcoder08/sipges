package app

import (
	"net/http"

	audithttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/audit/http"
)

func init() {
	registerContext("audit", func(d Deps) (func(*http.ServeMux), error) {
		return func(mux *http.ServeMux) {
			audithttp.Register(mux, audithttp.Deps{Pool: d.Pool, Logger: d.Logger, Now: d.Now})
		}, nil
	})
}

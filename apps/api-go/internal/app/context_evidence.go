package app

import (
	"net/http"

	evidencehttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/http"
)

func init() {
	registerContext("evidence", func(d Deps) (func(*http.ServeMux), error) {
		return func(mux *http.ServeMux) {
			evidencehttp.Register(mux, evidencehttp.Deps{DB: d.Pool, Logger: d.Logger})
		}, nil
	})
}

package app

import (
	"net/http"

	geographyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/http"
)

func init() {
	registerContext("geography", func(d Deps) (func(*http.ServeMux), error) {
		return func(mux *http.ServeMux) {
			geographyhttp.Register(mux, geographyhttp.Deps{Pool: d.Pool, Logger: d.Logger, Now: d.Now})
		}, nil
	})
}

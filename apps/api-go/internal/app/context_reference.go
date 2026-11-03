package app

import (
	"context"
	"net/http"

	referenceapp "github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/application"
	referencedomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/domain"
	referencehttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/http"
	reference "github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/infrastructure"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

func init() {
	registerContext("reference", func(d Deps) (func(*http.ServeMux), error) {
		references, err := reference.NewEmbeddedReader()
		if err != nil {
			return nil, err
		}
		service := referenceapp.NewService(references)
		return func(mux *http.ServeMux) { referencehttp.Register(mux, service, referenceScope, d.Logger) }, nil
	})
}

// referenceScope hands the tenancy middleware's project to the reference context.
func referenceScope(ctx context.Context) (referencedomain.Scope, bool) {
	s, ok := tenancyhttp.ScopeFrom(ctx)
	return referencedomain.Scope{CompanyID: s.CompanyID, ProjectID: s.ProjectID}, ok
}

package http

import (
	"context"
	"io"
	"net/http"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/infrastructure"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	ontology "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// decideErrors is DECIDE_ERRORS of analyst-routes.ts.
var decideErrors = map[string]struct {
	status int
	detail string
}{
	application.DecideMissing: {http.StatusNotFound, "La propuesta ya no está disponible"},
	application.DecideTaken:   {http.StatusConflict, "Otra persona ya decidió esta propuesta"},
	application.DecideFailed:  {http.StatusUnprocessableEntity, "No se pudo aplicar la propuesta"},
}

type decidedJSON struct {
	OK     bool    `json:"ok"`
	Result *string `json:"result"`
}

// decide answers POST /system/briefing/proposals. Session, Origin, project scope and role gate ran
// before (internal/app); approving writes through the contexts that own the records, which audit.
func decide(w http.ResponseWriter, r *http.Request, opts Options, now func() time.Time, fail func(http.ResponseWriter, *http.Request)) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		raw = nil
	}
	in, issues := ontology.ParseProposalDecisionIn(raw)
	if issues != nil {
		httpx.WriteJSONText(w, http.StatusUnprocessableEntity, httpx.ErrorBody{Detail: issues})
		return
	}
	scope, hasScope := tenancyhttp.ScopeFrom(r.Context())
	principal, hasPrincipal := identityhttp.PrincipalFrom(r.Context())
	if !hasScope || !hasPrincipal {
		fail(w, r)
		return
	}
	at := now().Truncate(time.Millisecond)
	open := func(context.Context) ([]domain.Proposal, bool, error) {
		found, err := tenancyhttp.WithRequestTenant(r, opts.DB, func(ctx context.Context, q database.Querier) (result[[]domain.Proposal], error) {
			proposals, ok, err := application.Proposals(ctx, infrastructure.Reader{Q: q}, in.Module, in.ID, at)
			return result[[]domain.Proposal]{proposals, ok}, err
		})
		return found.value, found.found, err
	}
	created, kind, err := opts.Deciding.Decide(r.Context(), scope.TenantID(), open, application.DecisionInput{
		Slug: in.Module, ID: in.ID, Fingerprint: in.Fingerprint, Approve: in.Decision == "approve",
	}, principal.Username, at)
	if err != nil {
		fail(w, r)
		return
	}
	if e, refused := decideErrors[kind]; refused {
		httpx.WriteJSONText(w, e.status, httpx.ErrorBody{Detail: e.detail})
		return
	}
	httpx.WriteJSONText(w, http.StatusOK, decidedJSON{OK: true, Result: created})
}

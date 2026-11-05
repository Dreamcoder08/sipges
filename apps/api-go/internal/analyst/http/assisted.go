package http

import (
	"context"
	"net/http"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// assisted answers GET /system/briefing with a narrator configured. The records are read in one
// tenant transaction; the guard and the narrator work after it ends.
func assisted(w http.ResponseWriter, r *http.Request, opts Options, module, id string, at time.Time, fail func(http.ResponseWriter, *http.Request)) {
	scope, ok := tenancyhttp.ScopeFrom(r.Context())
	if !ok {
		fail(w, r)
		return
	}
	found, err := tenancyhttp.WithRequestTenant(r, opts.DB, func(ctx context.Context, q database.Querier) (result[application.Neighbourhood], error) {
		value, ok, err := application.Neighbours(ctx, infrastructure.Reader{Q: q}, module, id)
		return result[application.Neighbourhood]{value, ok}, err
	})
	if err != nil {
		fail(w, r)
		return
	}
	if !found.found {
		httpx.WriteError(w, http.StatusNotFound, notFound)
		return
	}
	brief := opts.Assisted.Brief(r.Context(), scope.TenantID(), found.value, at)
	out := toBriefingJSON(brief.Briefing, at)
	out.Engine, out.Narrator, out.Notice = brief.Engine, brief.Narrator, brief.Notice
	if brief.Narrative != nil {
		out.Narrative = &sentenceJSON{Text: domain.Text(brief.Narrative.Text), Refs: brief.Narrative.Refs}
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

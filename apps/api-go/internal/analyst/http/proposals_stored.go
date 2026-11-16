package http

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// The Inicio analyst's stored proposals (odd/tasks/agentic-analyst.md S4), for Bandeja and
// sipgesctl:
//
//   - GET /system/analyst/proposals: the project's pending proposals;
//   - POST /system/analyst/proposals: {"id", "decision": "approve"|"reject"} decides one through
//     the same actions, decision row and audit as POST /system/briefing/proposals.
//
// The role gate ran before (internal/app); MayWrite adds the gate of the proposal's own write.

const storedProposalsPath = "/system/analyst/proposals"

// maxStoredProposalID bounds the id a decision names (the column holds 40).
const maxStoredProposalID = 40

type storedProposalJSON struct {
	ID string `json:"id"`
	proposalJSON
	ProposedBy string `json:"proposed_by"`
	ProposedAt string `json:"proposed_at"`
}

type storedDecisionIn struct {
	ID       string `json:"id"`
	Decision string `json:"decision"`
}

const invalidDecision = "Indique id y decision (approve o reject)"

func parseStoredDecision(raw []byte) (storedDecisionIn, bool) {
	var in storedDecisionIn
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil || dec.More() {
		return in, false
	}
	ok := in.ID != "" && len(in.ID) <= maxStoredProposalID && (in.Decision == "approve" || in.Decision == "reject")
	return in, ok
}

func storedProposalRoutes(mux *http.ServeMux, opts Options, fail func(http.ResponseWriter, *http.Request)) {
	mux.HandleFunc("GET "+storedProposalsPath, func(w http.ResponseWriter, r *http.Request) {
		scope, ok := tenancyhttp.ScopeFrom(r.Context())
		if !ok || opts.Deciding.Proposals == nil {
			fail(w, r)
			return
		}
		pending, err := opts.Deciding.Proposals.Pending(r.Context(), scope.TenantID())
		if err != nil {
			fail(w, r)
			return
		}
		out := make([]storedProposalJSON, 0, len(pending))
		for _, p := range pending {
			out = append(out, storedProposalJSON{
				ID: p.ID, proposalJSON: toProposalJSON(p.Proposal),
				ProposedBy: p.ProposedBy, ProposedAt: p.ProposedAt.UTC().Format(time.RFC3339),
			})
		}
		httpx.WriteJSON(w, http.StatusOK, out)
	})

	mux.HandleFunc("POST "+storedProposalsPath, func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			raw = nil
		}
		in, valid := parseStoredDecision(raw)
		if !valid {
			httpx.WriteJSONText(w, http.StatusUnprocessableEntity, httpx.ErrorBody{Detail: invalidDecision})
			return
		}
		scope, hasScope := tenancyhttp.ScopeFrom(r.Context())
		principal, hasPrincipal := identityhttp.PrincipalFrom(r.Context())
		if !hasScope || !hasPrincipal || opts.Deciding.Proposals == nil || opts.MayWrite == nil {
			fail(w, r)
			return
		}
		mayWrite := func(ctx context.Context, p domain.Proposal) bool {
			return opts.MayWrite(ctx, http.MethodPost, application.ProposalWritePath(p))
		}
		created, kind, err := opts.Deciding.DecideStored(r.Context(), scope.TenantID(), in.ID, in.Decision == "approve",
			principal.Username, mayWrite)
		if err != nil {
			fail(w, r)
			return
		}
		if kind == application.DecideForbidden {
			httpx.WriteJSONText(w, http.StatusForbidden, httpx.ErrorBody{Detail: domain.RefusedRole})
			return
		}
		if e, refused := decideErrors[kind]; refused {
			httpx.WriteJSONText(w, e.status, httpx.ErrorBody{Detail: e.detail})
			return
		}
		httpx.WriteJSONText(w, http.StatusOK, decidedJSON{OK: true, Result: created})
	})
}

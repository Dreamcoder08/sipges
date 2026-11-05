package http

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"time"

	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// The write routes of ontology-routes.ts (POST /system/links, PUT /system/links/:id/evidence,
// PUT /system/marking, DELETE /system/links/:id) and the neighbourhood POST, with the same
// statuses and bodies. The role gate ran before: the read-only role and the coordinator never
// reach a write here, while the neighbourhood is a read-only POST every role may send.

const missingLink = "Vínculo no encontrado"

// writeJSON is httpx.WriteJSON without HTML escaping, as JSON.stringify writes: the 422 bodies
// hold ">=" and "<=". Summaries keep their own marshalling (equal as JSON values).
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v) // the status is already sent; a failed write has no recovery
}

func writeError(w http.ResponseWriter, status int, detail any) {
	writeJSON(w, status, httpx.ErrorBody{Detail: detail})
}

// linkErrors is LINK_ERRORS.
var linkErrors = map[string]struct {
	status int
	detail string
}{
	string(domain.UnknownType):    {http.StatusUnprocessableEntity, "Tipo de vínculo no válido"},
	string(domain.UnknownObject):  {http.StatusUnprocessableEntity, "Tipo de objeto no válido"},
	string(domain.SelfLink):       {http.StatusUnprocessableEntity, "Un registro no puede vincularse consigo mismo"},
	string(domain.NotAllowed):     {http.StatusUnprocessableEntity, "El tipo de vínculo no admite esos tipos de objeto"},
	string(application.Missing):   {http.StatusNotFound, missingRecord},
	string(application.Duplicate): {http.StatusConflict, "El vínculo ya existe"},
}

// linkID is the :id of the link routes: /^\d{1,9}$/ (ASCII digits), else no link.
var linkID = regexp.MustCompile(`^[0-9]{1,9}$`)

func parseLinkID(r *http.Request) (int64, bool) {
	raw := httpx.PathParam(r, "id")
	if !linkID.MatchString(raw) {
		return 0, false
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	return id, err == nil
}

func registerWrites(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("POST /system/links", d.createLink)
	mux.HandleFunc("PUT /system/links/{id}/evidence", d.setEvidence)
	mux.HandleFunc("PUT /system/marking", d.classify)
	mux.HandleFunc("DELETE /system/links/{id}", d.unlink)
	mux.HandleFunc("POST /system/graph/neighbourhood", d.neighbourhood)
}

// body reads the request body as parseJson does; nil issues means it is valid. A body that
// cannot be read is JSON that cannot be parsed.
func body[T any](w http.ResponseWriter, r *http.Request, parse func([]byte) (T, []domain.Issue)) (T, bool) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		raw = nil
	}
	v, issues := parse(raw)
	if issues != nil {
		writeError(w, http.StatusUnprocessableEntity, issues)
		return v, false
	}
	return v, true
}

// now is the clock in JavaScript's precision: Date holds milliseconds.
func (d Deps) now() time.Time {
	if d.Now == nil {
		return time.Now().Truncate(time.Millisecond)
	}
	return d.Now().Truncate(time.Millisecond)
}

// write runs fn over the request's tenant transaction, which commits when fn succeeds.
func write[T any](r *http.Request, d Deps, fn func(context.Context, application.Writes) (T, error)) (T, error) {
	at := d.now()
	return tenancyhttp.WithRequestTenant(r, d.DB, func(ctx context.Context, q database.Querier) (T, error) {
		return fn(ctx, application.Writes{Store: infrastructure.Store{Q: q}, Now: at})
	})
}

type created struct {
	OK bool  `json:"ok"`
	ID int64 `json:"id"`
}

type okJSON struct {
	OK bool `json:"ok"`
}

type markedJSON struct {
	OK      bool   `json:"ok"`
	Marking string `json:"marking"`
}

func (d Deps) createLink(w http.ResponseWriter, r *http.Request) {
	in, ok := body(w, r, domain.ParseLinkIn)
	if !ok {
		return
	}
	principal, ok := identityhttp.PrincipalFrom(r.Context())
	if !ok {
		d.fail(w, r) // unreachable behind the session middleware
		return
	}
	type result struct {
		id      int64
		problem string
	}
	out, err := write(r, d, func(ctx context.Context, s application.Writes) (result, error) {
		id, problem, err := s.Link(ctx, application.LinkInput{
			LinkType: in.LinkType, Source: in.Source, Target: in.Target, Note: in.Note, Evidence: in.Evidence,
		}, principal.Username)
		return result{id, problem}, err
	})
	switch {
	case err != nil:
		d.fail(w, r)
	case out.problem != "":
		e := linkErrors[out.problem]
		writeError(w, e.status, e.detail)
	default:
		writeJSON(w, http.StatusOK, created{OK: true, ID: out.id})
	}
}

func (d Deps) setEvidence(w http.ResponseWriter, r *http.Request) {
	in, ok := body(w, r, domain.ParseEvidenceIn)
	if !ok {
		return
	}
	id, ok := parseLinkID(r)
	if !ok {
		writeError(w, http.StatusNotFound, missingRecord)
		return
	}
	var source *string
	if in.Evidence != nil {
		source = &in.Evidence.ID
	}
	updated, err := write(r, d, func(ctx context.Context, s application.Writes) (bool, error) {
		return s.SetLinkEvidence(ctx, id, source)
	})
	switch {
	case err != nil:
		d.fail(w, r)
	case !updated:
		writeError(w, http.StatusNotFound, missingRecord)
	default:
		writeJSON(w, http.StatusOK, okJSON{true})
	}
}

func (d Deps) classify(w http.ResponseWriter, r *http.Request) {
	in, ok := body(w, r, domain.ParseMarkingIn)
	if !ok {
		return
	}
	classified, err := write(r, d, func(ctx context.Context, s application.Writes) (bool, error) {
		return s.Classify(ctx, in.Module, in.ID, in.Marking)
	})
	switch {
	case err != nil:
		d.fail(w, r)
	case !classified:
		writeError(w, http.StatusNotFound, missingRecord)
	default:
		writeJSON(w, http.StatusOK, markedJSON{true, in.Marking})
	}
}

func (d Deps) unlink(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLinkID(r)
	if !ok {
		writeError(w, http.StatusNotFound, missingLink)
		return
	}
	removed, err := write(r, d, func(ctx context.Context, s application.Writes) (bool, error) {
		return s.Unlink(ctx, id)
	})
	switch {
	case err != nil:
		d.fail(w, r)
	case !removed:
		writeError(w, http.StatusNotFound, missingLink)
	default:
		writeJSON(w, http.StatusOK, okJSON{true})
	}
}

type neighbourhoodJSON struct {
	Seeds     []domain.Ref     `json:"seeds"`
	Nodes     []domain.Summary `json:"nodes"`
	Edges     []edgeJSON       `json:"edges"`
	Truncated bool             `json:"truncated"`
}

func (d Deps) neighbourhood(w http.ResponseWriter, r *http.Request) {
	in, ok := body(w, r, domain.ParseNeighbourhoodIn)
	if !ok {
		return
	}
	for _, hop := range in.Hops {
		for _, id := range hop {
			if _, known := domain.LinkTypeByID(id); !known {
				writeError(w, http.StatusUnprocessableEntity, "Tipo de vínculo no válido: "+id)
				return
			}
		}
	}
	found, err := read(r, d.DB, func(ctx context.Context, s application.Service) (*application.Neighbourhood, error) {
		return s.Neighbourhood(ctx, in.Seeds, in.Hops, in.Fields)
	})
	if err != nil {
		d.fail(w, r)
		return
	}
	writeJSON(w, http.StatusOK, neighbourhoodJSON{
		Seeds: found.Seeds, Nodes: found.Nodes, Edges: edgesOut(found.Edges), Truncated: found.Truncated,
	})
}

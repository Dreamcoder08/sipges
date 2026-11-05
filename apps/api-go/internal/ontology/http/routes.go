// Package http serves the routes of apps/api/src/contexts/ontology/http/ontology-routes.ts with
// the same JSON: GET /system/ontology, /system/search, /system/timeline, /system/links and
// /system/graph; POST /system/graph/neighbourhood; and the writes (writes.go): POST
// /system/links, PUT /system/links/:id/evidence, PUT /system/marking and DELETE
// /system/links/:id. The session, project scope and role gate ran before (internal/app); every
// route runs in the request's tenant transaction (tenancyhttp.WithRequestTenant), except semantic
// search, whose steps each have one so that none stays open across a call to the model.
package http

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// The TypeScript API's bodies, byte for byte.
const (
	missingRecord = "Registro no encontrado"
	invalidDates  = "Fechas no válidas: use AAAA, AAAA-MM o AAAA-MM-DD"
)

// Deps is what the routes need.
type Deps struct {
	DB     database.Beginner
	Logger *slog.Logger
	// Now is the clock of the writes; nil means time.Now.
	Now func() time.Time
	// Semantic makes search hybrid; nil keeps it lexical (SIPGES_SEMANTIC_SEARCH off).
	Semantic *application.Semantic
}

// Register mounts the ontology routes on mux.
func Register(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("GET /system/ontology", func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, domain.Catalog())
	})
	mux.HandleFunc("GET /system/search", d.search)
	mux.HandleFunc("GET /system/timeline", d.timeline)
	mux.HandleFunc("GET /system/links", d.links)
	mux.HandleFunc("GET /system/graph", d.graph)
	registerWrites(mux, d)
}

// query is c.req.query(name), or the empty string when absent.
func query(r *http.Request, name string) string {
	v, _ := httpx.QueryParam(r, name)
	return v
}

// modules is `modules ? modules.split(',').filter(Boolean) : null`.
func modules(r *http.Request) []string {
	raw := query(r, "modules")
	if raw == "" {
		return nil
	}
	out := []string{}
	for _, m := range strings.Split(raw, ",") {
		if m != "" {
			out = append(out, m)
		}
	}
	return out
}

type endJSON struct {
	Module string `json:"module"`
	ID     string `json:"id"`
}

type edgeJSON struct {
	ID             *int64          `json:"id"`
	LinkType       string          `json:"link_type"`
	Source         endJSON         `json:"source"`
	Target         endJSON         `json:"target"`
	Inferred       bool            `json:"inferred"`
	Via            *string         `json:"via"`
	Note           string          `json:"note"`
	CreatedBy      *string         `json:"created_by"`
	CreatedAt      *string         `json:"created_at"`
	Evidence       *domain.Summary `json:"evidence"`
	EvidenceStatus string          `json:"evidence_status"`
}

// isoSeconds is isoSeconds of platform/http/time.ts for the years links are stamped with.
func isoSeconds(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05Z") }

// edgeOut is edgeOut of ontology-routes.ts.
func edgeOut(e application.Edge) edgeJSON {
	out := edgeJSON{
		ID: e.ID, LinkType: e.LinkType,
		Source: endJSON{e.Source.Slug, e.Source.ID}, Target: endJSON{e.Target.Slug, e.Target.ID},
		Inferred: e.Inferred, Via: e.Via, Note: e.Note, CreatedBy: e.CreatedBy, Evidence: e.Evidence,
		EvidenceStatus: e.EvidenceStatus,
	}
	if e.CreatedAt != nil {
		at := isoSeconds(*e.CreatedAt)
		out.CreatedAt = &at
	}
	if out.EvidenceStatus == "" {
		out.EvidenceStatus = "undocumented"
	}
	return out
}

func edgesOut(edges []application.Edge) []edgeJSON {
	out := make([]edgeJSON, 0, len(edges))
	for _, e := range edges {
		out = append(out, edgeOut(e))
	}
	return out
}

type hitJSON struct {
	domain.Summary
	Match    *domain.Match `json:"match"`
	Semantic bool          `json:"semantic"`
}

type searchJSON struct {
	Query domain.Text `json:"query"`
	Hits  []hitJSON   `json:"hits"`
}

func (d Deps) search(w http.ResponseWriter, r *http.Request) {
	q := domain.UnitsOf(query(r, "q")).Slice(0, 200)
	limit, ok := parseIntQuery(w, r, "limit", 20)
	if !ok {
		return
	}
	slugs := modules(r)
	hits, err := d.hits(r, q, slugs, limit)
	if err != nil {
		d.fail(w, r)
		return
	}
	out := searchJSON{Query: q.Text(), Hits: make([]hitJSON, 0, len(hits))}
	for _, h := range hits {
		out.Hits = append(out.Hits, hitJSON{Summary: h.Summary, Match: h.Match, Semantic: h.Semantic})
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

type timelineJSON struct {
	From      string           `json:"from"`
	To        string           `json:"to"`
	Entries   []domain.Summary `json:"entries"`
	Truncated bool             `json:"truncated"`
}

func (d Deps) timeline(w http.ResponseWriter, r *http.Request) {
	limit, ok := parseIntQuery(w, r, "limit", 200)
	if !ok {
		return
	}
	slugs := modules(r)
	from := domain.UnitsOf(query(r, "from")).Slice(0, 10).String()
	to := domain.UnitsOf(query(r, "to")).Slice(0, 10).String()
	found, err := read(r, d.DB, func(ctx context.Context, s application.Service) (*application.Timeline, error) {
		return s.Timeline(ctx, from, to, slugs, limit)
	})
	switch {
	case err != nil:
		d.fail(w, r)
	case found == nil:
		httpx.WriteError(w, http.StatusUnprocessableEntity, invalidDates)
	default:
		httpx.WriteJSON(w, http.StatusOK, timelineJSON{found.From, found.To, found.Entries, found.Truncated})
	}
}

type neighbourJSON struct {
	Edge      edgeJSON       `json:"edge"`
	Direction string         `json:"direction"`
	Label     string         `json:"label"`
	Other     domain.Summary `json:"other"`
}

type linksJSON struct {
	Record domain.Summary  `json:"record"`
	Links  []neighbourJSON `json:"links"`
}

func (d Deps) links(w http.ResponseWriter, r *http.Request) {
	module, id := query(r, "module"), query(r, "id")
	found, err := read(r, d.DB, func(ctx context.Context, s application.Service) (*application.Links, error) {
		return s.Neighbours(ctx, module, id)
	})
	switch {
	case err != nil:
		d.fail(w, r)
	case found == nil:
		httpx.WriteError(w, http.StatusNotFound, missingRecord)
	default:
		out := linksJSON{Record: found.Record, Links: make([]neighbourJSON, 0, len(found.Neighbours))}
		for _, n := range found.Neighbours {
			out.Links = append(out.Links, neighbourJSON{edgeOut(n.Edge), n.Direction, n.Label, n.Other})
		}
		httpx.WriteJSON(w, http.StatusOK, out)
	}
}

type graphJSON struct {
	Root      endJSON          `json:"root"`
	Nodes     []domain.Summary `json:"nodes"`
	Edges     []edgeJSON       `json:"edges"`
	Truncated bool             `json:"truncated"`
}

func (d Deps) graph(w http.ResponseWriter, r *http.Request) {
	module, id := query(r, "module"), query(r, "id")
	depth, ok := parseIntQuery(w, r, "depth", 1)
	if !ok {
		return
	}
	found, err := read(r, d.DB, func(ctx context.Context, s application.Service) (*application.Graph, error) {
		return s.Graph(ctx, module, id, depth)
	})
	switch {
	case err != nil:
		d.fail(w, r)
	case found == nil:
		httpx.WriteError(w, http.StatusNotFound, missingRecord)
	default:
		httpx.WriteJSON(w, http.StatusOK, graphJSON{
			Root: endJSON{found.Root.Slug, found.Root.ID}, Nodes: found.Nodes,
			Edges: edgesOut(found.Edges), Truncated: found.Truncated,
		})
	}
}

// read runs fn over the request's tenant transaction.
func read[T any](r *http.Request, db database.Beginner, fn func(context.Context, application.Service) (T, error)) (T, error) {
	return tenancyhttp.WithRequestTenant(r, db, func(ctx context.Context, q database.Querier) (T, error) {
		return fn(ctx, application.Service{Store: infrastructure.Store{Q: q}})
	})
}

// fail is the TypeScript API's onError 500; only the event is logged, since driver errors may
// carry connection details.
func (d Deps) fail(w http.ResponseWriter, r *http.Request) {
	if d.Logger != nil {
		d.Logger.LogAttrs(r.Context(), slog.LevelError, "ontology request failed",
			slog.String("request_id", httpx.RequestIDFrom(r.Context())))
	}
	httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
}

type validationIssue struct {
	Type string `json:"type"`
	Loc  []any  `json:"loc"`
	Msg  string `json:"msg"`
}

// parseIntQuery is parseIntQuery of apps/api/src/platform/http/validation.ts: the fallback when
// absent, a 422 when the value does not match /^\s*[+-]?\d+\s*$/, else its value saturated at
// the int64 bounds (every caller clamps it to a small range, as JavaScript does).
func parseIntQuery(w http.ResponseWriter, r *http.Request, name string, fallback int64) (int64, bool) {
	raw, present := httpx.QueryParam(r, name)
	if !present {
		return fallback, true
	}
	if value, ok := parseJSInt(strings.TrimFunc(raw, js.IsJSSpace)); ok {
		return value, true
	}
	httpx.WriteError(w, http.StatusUnprocessableEntity, []validationIssue{{
		Type: "int_parsing",
		Loc:  []any{"query", name},
		Msg:  "Input should be a valid integer, unable to parse string as an integer",
	}})
	return 0, false
}

// parseJSInt reads [+-]?\d+ with ASCII digits only, as JavaScript's \d.
func parseJSInt(s string) (int64, bool) {
	digits := strings.TrimLeft(s, "+-")
	if len(s)-len(digits) > 1 || digits == "" || strings.Trim(digits, "0123456789") != "" {
		return 0, false
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if errors.Is(err, strconv.ErrRange) {
		if strings.HasPrefix(s, "-") {
			return math.MinInt64, true
		}
		return math.MaxInt64, true
	}
	return v, err == nil
}

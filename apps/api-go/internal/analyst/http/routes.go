// Package http serves the deterministic read routes of
// apps/api/src/contexts/analyst/http/analyst-routes.ts with the same JSON:
//
//   - GET /system/briefing: the extractive briefing (engine "extractivo"), which is what TypeScript
//     answers while no narrator is configured (SIPGES_ANALYST_PROVIDER unset);
//   - GET /system/briefing/proposals: the record's open proposals.
//
// The session, project scope and role gate ran before (internal/app); every read runs in the
// scope's tenant transaction. The assisted briefing (a language model behind the egress guard)
// and POST /system/briefing/proposals (writes through other contexts, audited) stay in TypeScript.
//
//nolint:misspell // Spanish record fields, modules and messages, verbatim from the TypeScript API.
package http

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// Options configures Routes.
type Options struct {
	DB database.Beginner
	// Now is the clock for "today" and generated_at; nil means time.Now.
	Now    func() time.Time
	Logger *slog.Logger
}

const notFound = "Registro no encontrado"

type subjectJSON struct {
	Module    string                 `json:"module"`
	ID        domain.Text            `json:"id"`
	TypeLabel string                 `json:"type_label"`
	Title     domain.Text            `json:"title"`
	Date      *domain.Text           `json:"date"`
	Marking   string                 `json:"marking"`
	Fields    map[string]domain.Text `json:"fields"`
}

type sentenceJSON struct {
	Text domain.Text `json:"text"`
	Refs []int       `json:"refs"`
}

type sectionJSON struct {
	Title     string         `json:"title"`
	Sentences []sentenceJSON `json:"sentences"`
}

type sourceJSON struct {
	Ref       int         `json:"ref"`
	Module    string      `json:"module"`
	ID        domain.Text `json:"id"`
	TypeLabel string      `json:"type_label"`
	Title     domain.Text `json:"title"`
}

type briefingJSON struct {
	Subject     subjectJSON   `json:"subject"`
	GeneratedAt string        `json:"generated_at"`
	Engine      string        `json:"engine"`
	Narrator    *string       `json:"narrator"`
	Notice      *string       `json:"notice"`
	Narrative   *sentenceJSON `json:"narrative"`
	Sections    []sectionJSON `json:"sections"`
	Sources     []sourceJSON  `json:"sources"`
}

// isoSeconds is isoSeconds of platform/http/time.ts: ISO 8601 UTC without fractional seconds.
func isoSeconds(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05Z") }

func fieldsJSON(fields []domain.Field) map[string]domain.Text {
	out := make(map[string]domain.Text, len(fields))
	for _, f := range fields {
		value, _ := f.Value.(string)
		out[f.Key] = domain.Text(value)
	}
	return out
}

// toBriefingJSON is the JSON of GET /system/briefing for an extractive briefing.
func toBriefingJSON(b domain.Briefing, now time.Time) briefingJSON {
	s := b.Subject
	out := briefingJSON{
		Subject: subjectJSON{
			Module: s.Slug, ID: domain.Text(s.ID), TypeLabel: s.TypeLabel, Title: domain.Text(s.Title),
			Marking: s.Marking, Fields: fieldsJSON(s.Fields),
		},
		GeneratedAt: isoSeconds(now),
		Engine:      "extractivo",
		Sections:    make([]sectionJSON, 0, len(b.Sections)),
		Sources:     make([]sourceJSON, 0, len(b.Sources)),
	}
	if s.Date != nil {
		date := domain.Text(*s.Date)
		out.Subject.Date = &date
	}
	for _, section := range b.Sections {
		sentences := make([]sentenceJSON, 0, len(section.Sentences))
		for _, sentence := range section.Sentences {
			sentences = append(sentences, sentenceJSON{Text: domain.Text(sentence.Text), Refs: append([]int{}, sentence.Refs...)})
		}
		out.Sections = append(out.Sections, sectionJSON{Title: section.Title, Sentences: sentences})
	}
	for _, source := range b.Sources {
		out.Sources = append(out.Sources, sourceJSON{
			Ref: source.Ref, Module: source.Slug, ID: domain.Text(source.ID), TypeLabel: source.TypeLabel, Title: domain.Text(source.Title),
		})
	}
	return out
}

type endJSON struct {
	Module string      `json:"module"`
	ID     domain.Text `json:"id"`
}

type linkJSON struct {
	LinkType string  `json:"link_type"`
	Source   endJSON `json:"source"`
	Target   endJSON `json:"target"`
}

type recordJSON struct {
	Module  string                 `json:"module"`
	Payload map[string]domain.Text `json:"payload"`
}

type proposalJSON struct {
	Fingerprint domain.Text `json:"fingerprint"`
	Kind        string      `json:"kind"`
	Title       domain.Text `json:"title"`
	Reason      domain.Text `json:"reason"`
	Link        *linkJSON   `json:"link"`
	Record      *recordJSON `json:"record"`
}

// toProposalJSON is proposalOut of analyst-routes.ts.
func toProposalJSON(p domain.Proposal) proposalJSON {
	out := proposalJSON{Fingerprint: domain.Text(p.Fingerprint), Kind: p.Kind, Title: domain.Text(p.Title), Reason: domain.Text(p.Reason)}
	if p.Link != nil {
		out.Link = &linkJSON{
			LinkType: p.Link.LinkType,
			Source:   endJSON{p.Link.Source.Slug, domain.Text(p.Link.Source.ID)},
			Target:   endJSON{p.Link.Target.Slug, domain.Text(p.Link.Target.ID)},
		}
	}
	if p.Record != nil {
		out.Record = &recordJSON{Module: p.Record.Slug, Payload: fieldsJSON(p.Record.Payload)}
	}
	return out
}

// subjectOf reads the module and id query parameters; a missing one is empty, as in TypeScript.
func subjectOf(r *http.Request) (string, string) {
	module, _ := httpx.QueryParam(r, "module")
	id, _ := httpx.QueryParam(r, "id")
	return module, id
}

type result[T any] struct {
	value T
	found bool
}

// Routes registers the analyst's read routes on mux.
func Routes(mux *http.ServeMux, opts Options) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	fail := func(w http.ResponseWriter, r *http.Request) {
		// Only the event: driver errors may carry connection details.
		if opts.Logger != nil {
			opts.Logger.LogAttrs(r.Context(), slog.LevelError, "analyst read failed",
				slog.String("request_id", httpx.RequestIDFrom(r.Context())))
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
	}

	mux.HandleFunc("GET /system/briefing/proposals", func(w http.ResponseWriter, r *http.Request) {
		module, id := subjectOf(r)
		at := now()
		found, err := tenancyhttp.WithRequestTenant(r, opts.DB, func(ctx context.Context, q database.Querier) (result[[]domain.Proposal], error) {
			proposals, ok, err := application.Proposals(ctx, infrastructure.Reader{Q: q}, module, id, at)
			return result[[]domain.Proposal]{proposals, ok}, err
		})
		if err != nil {
			fail(w, r)
			return
		}
		if !found.found {
			httpx.WriteError(w, http.StatusNotFound, notFound)
			return
		}
		out := make([]proposalJSON, 0, len(found.value))
		for _, p := range found.value {
			out = append(out, toProposalJSON(p))
		}
		httpx.WriteJSON(w, http.StatusOK, out)
	})

	mux.HandleFunc("GET /system/briefing", func(w http.ResponseWriter, r *http.Request) {
		module, id := subjectOf(r)
		at := now()
		found, err := tenancyhttp.WithRequestTenant(r, opts.DB, func(ctx context.Context, q database.Querier) (result[domain.Briefing], error) {
			briefing, ok, err := application.Briefing(ctx, infrastructure.Reader{Q: q}, module, id, at)
			return result[domain.Briefing]{briefing, ok}, err
		})
		if err != nil {
			fail(w, r)
			return
		}
		if !found.found {
			httpx.WriteError(w, http.StatusNotFound, notFound)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, toBriefingJSON(found.value, at))
	})
}

package http

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// hits is the search: lexical, or hybrid with an embedder. The lexical query, the semantic refs and
// the fusion each take their own transactions: a call to the model can take seconds.
func (d Deps) hits(r *http.Request, q domain.Units, slugs []string, limit int64) ([]application.Hit, error) {
	if d.Semantic == nil {
		return read(r, d.DB, func(ctx context.Context, s application.Service) ([]application.Hit, error) {
			return s.Search(ctx, q, slugs, limit)
		})
	}
	found, err := read(r, d.DB, func(ctx context.Context, s application.Service) (application.Lexical, error) {
		return s.Lexical(ctx, q, slugs, limit)
	})
	if err != nil {
		return nil, err
	}
	if len(found.Modules) == 0 {
		return []application.Hit{}, nil
	}
	refs := d.semanticRefs(r, q, found)
	return read(r, d.DB, func(ctx context.Context, s application.Service) ([]application.Hit, error) {
		return s.Fuse(ctx, found, refs)
	})
}

// semanticRefs leaves the lexical result untouched on any failure. Only the event is logged: an
// error may carry connection details or text.
func (d Deps) semanticRefs(r *http.Request, q domain.Units, found application.Lexical) []application.NodeRef {
	scope, ok := tenancyhttp.ScopeFrom(r.Context())
	if !ok || len(found.Terms) == 0 {
		return nil
	}
	// Text keeps half an emoji where the route cut the query, as WTF-8; String would replace it.
	refs, err := d.Semantic.Refs(r.Context(), scope.TenantID(), string(q.Text()), found.Modules, found.Bounded, d.inTenant(r))
	if err != nil {
		if d.Logger != nil {
			d.Logger.LogAttrs(r.Context(), slog.LevelWarn, "semantic_search_unavailable",
				slog.String("request_id", httpx.RequestIDFrom(r.Context())))
		}
		return nil
	}
	return refs
}

func (d Deps) inTenant(r *http.Request) application.InTenant {
	return func(work func(context.Context, application.EmbeddingIndex) error) error {
		_, err := tenancyhttp.WithRequestTenant(r, d.DB, func(ctx context.Context, q database.Querier) (struct{}, error) {
			return struct{}{}, work(ctx, infrastructure.EmbeddingIndex{Q: q})
		})
		return err
	}
}

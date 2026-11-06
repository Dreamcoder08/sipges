package http

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// searchWriteBudget is how long a hybrid search may take to answer: 16 records and the query at the
// embedder's 12 s each, plus the database. The server's own WriteTimeout is shorter, and stays as
// it is for every other route.
const searchWriteBudget = 4 * time.Minute

// ExtendWriteDeadline gives a hybrid search its budget. A slow model is not a failure of the
// search: without this the server cuts the connection and the lexical result never arrives.
func (d Deps) ExtendWriteDeadline(w http.ResponseWriter, r *http.Request) {
	if d.Semantic == nil {
		return
	}
	err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(searchWriteBudget))
	if err != nil && d.Logger != nil {
		d.Logger.LogAttrs(r.Context(), slog.LevelWarn, "search_write_deadline_unavailable",
			slog.String("request_id", httpx.RequestIDFrom(r.Context())))
	}
}

// hits is the search of the request's project.
func (d Deps) hits(r *http.Request, q domain.Units, slugs []string, limit int64) ([]application.Hit, error) {
	scope, ok := tenancyhttp.ScopeFrom(r.Context())
	if !ok {
		return nil, tenancyhttp.ErrNoScope
	}
	return d.Search(r.Context(), scope.TenantID(), q, slugs, limit, nil)
}

// Search is the search of a project: lexical, or hybrid with an embedder; see
// application.Service.Visible. The lexical query, the semantic refs and the fusion each take their
// own transactions: a call to the model can take seconds.
func (d Deps) Search(ctx context.Context, tenantID string, q domain.Units, slugs []string, limit int64, visible application.VisibleField) ([]application.Hit, error) {
	tenant := func(fn func(context.Context, application.Service) ([]application.Hit, error)) ([]application.Hit, error) {
		return database.WithTenant(ctx, d.DB, tenantID, func(ctx context.Context, tx database.Querier) ([]application.Hit, error) {
			return fn(ctx, application.Service{Store: infrastructure.Store{Q: tx}, Visible: visible})
		})
	}
	if d.Semantic == nil {
		return tenant(func(ctx context.Context, s application.Service) ([]application.Hit, error) {
			return s.Search(ctx, q, slugs, limit)
		})
	}
	found, err := database.WithTenant(ctx, d.DB, tenantID, func(ctx context.Context, tx database.Querier) (application.Lexical, error) {
		return application.Service{Store: infrastructure.Store{Q: tx}}.Lexical(ctx, q, slugs, limit)
	})
	if err != nil {
		return nil, err
	}
	if len(found.Modules) == 0 {
		return []application.Hit{}, nil
	}
	refs := d.semanticRefs(ctx, tenantID, q, found)
	return tenant(func(ctx context.Context, s application.Service) ([]application.Hit, error) {
		return s.Fuse(ctx, found, refs)
	})
}

// semanticRefs leaves the lexical result untouched on any failure. Only the event is logged: an
// error may carry connection details or text.
func (d Deps) semanticRefs(ctx context.Context, tenantID string, q domain.Units, found application.Lexical) []application.NodeRef {
	if len(found.Terms) == 0 {
		return nil
	}
	// Text keeps half an emoji where the route cut the query, as WTF-8; String would replace it.
	refs, err := d.Semantic.Refs(ctx, tenantID, string(q.Text()), found.Modules, found.Bounded, d.inTenant(ctx, tenantID))
	if err != nil {
		if d.Logger != nil {
			d.Logger.LogAttrs(ctx, slog.LevelWarn, "semantic_search_unavailable",
				slog.String("request_id", httpx.RequestIDFrom(ctx)))
		}
		return nil
	}
	return refs
}

func (d Deps) inTenant(ctx context.Context, tenantID string) application.InTenant {
	return func(work func(context.Context, application.EmbeddingIndex) error) error {
		_, err := database.WithTenant(ctx, d.DB, tenantID, func(ctx context.Context, q database.Querier) (struct{}, error) {
			return struct{}{}, work(ctx, infrastructure.EmbeddingIndex{Q: q})
		})
		return err
	}
}

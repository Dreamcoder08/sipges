package app

import (
	"context"
	"errors"
	"net/http"
	"time"

	analyst "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	analystsql "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/infrastructure"
	integration "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/application"
	integrationhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/http"
	ontology "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/application"
	ontologydomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
	ontologyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/http"
	ontologysql "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/config"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
	recordssql "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/infrastructure"
)

func init() {
	registerContext("mcp", func(d Deps) (func(*http.ServeMux), error) {
		tools, search, err := mcpTools(d)
		if err != nil {
			return nil, err
		}
		mcp := integrationhttp.MCP{Keys: apiKeys(d), Tools: tools, Log: d.Logger, SlowSearch: search.ExtendWriteDeadline}
		return func(mux *http.ServeMux) { integrationhttp.RegisterMCP(mux, mcp) }, nil
	})
}

// mcpTools composes the tools over the same services as the web app. Without SIPGES_DATA_KEY there
// is no guard, so every tool that reads tenant data is refused; in TypeScript that key is required.
func mcpTools(d Deps) (integration.MCP, ontologyhttp.Deps, error) {
	semantic, err := semanticSearch(d)
	if err != nil {
		return integration.MCP{}, ontologyhttp.Deps{}, err
	}
	assisted, err := assistedBriefing(d)
	if err != nil {
		return integration.MCP{}, ontologyhttp.Deps{}, err
	}
	search := ontologyhttp.Deps{DB: d.Pool, Logger: d.Logger, Now: d.Now, Semantic: semantic}
	tools := integration.MCP{
		Ontology: mcpOntology{d, search},
		Records:  records.Service{Store: recordssql.Records{DB: d.Pool}},
		Creator:  records.Writes{Store: recordssql.Records{DB: d.Pool}, Now: mcpClock(d), RandomHex: randomHexUpper},
		Analyst:  mcpBriefings{d, assisted},
	}
	guard, err := egressGuard(d)
	switch {
	case err == nil:
		tools.Guard = guard
	case !errors.Is(err, config.ErrNoDataKey):
		return integration.MCP{}, ontologyhttp.Deps{}, err
	}
	return tools, search, nil
}

func mcpClock(d Deps) func() time.Time {
	if d.Now != nil {
		return d.Now
	}
	return time.Now
}

// inProject runs one read in the project's tenant transaction, as the key the request carries.
func inProject[T any](ctx context.Context, d Deps, tenantID string, fn func(context.Context, ontology.Service) (T, error)) (T, error) {
	return database.WithTenant(ctx, d.Pool, tenantID, func(ctx context.Context, q database.Querier) (T, error) {
		return fn(ctx, ontology.Service{Store: ontologysql.Store{Q: q}})
	})
}

// mcpOntology implements integration.MCPOntology.
type mcpOntology struct {
	d      Deps
	search ontologyhttp.Deps
}

func (m mcpOntology) Search(ctx context.Context, tenantID string, query ontologydomain.Units, slugs []string, limit int64, visible ontology.VisibleField) ([]ontology.Hit, error) {
	return m.search.Search(ctx, tenantID, query, slugs, limit, visible)
}

func (m mcpOntology) Neighbours(ctx context.Context, tenantID, slug, id string) (*ontology.Links, error) {
	return inProject(ctx, m.d, tenantID, func(ctx context.Context, s ontology.Service) (*ontology.Links, error) {
		return s.Neighbours(ctx, slug, id)
	})
}

func (m mcpOntology) Timeline(ctx context.Context, tenantID, from, to string, slugs []string, limit int64) (*ontology.Timeline, error) {
	return inProject(ctx, m.d, tenantID, func(ctx context.Context, s ontology.Service) (*ontology.Timeline, error) {
		return s.Timeline(ctx, from, to, slugs, limit)
	})
}

func (m mcpOntology) Link(ctx context.Context, tenantID string, in ontology.LinkInput, actor string) (int64, string, error) {
	type created struct {
		id      int64
		problem string
	}
	at := mcpClock(m.d)().Truncate(time.Millisecond)
	got, err := database.WithTenant(ctx, m.d.Pool, tenantID, func(ctx context.Context, q database.Querier) (created, error) {
		id, problem, err := ontology.Writes{Store: ontologysql.Store{Q: q}, Now: at}.Link(ctx, in, actor)
		return created{id, problem}, err
	})
	return got.id, got.problem, err
}

// mcpBriefings implements integration.MCPBriefings. The records are read in one tenant transaction;
// the guard and the narrator work after it ends.
type mcpBriefings struct {
	d        Deps
	assisted *analyst.Assisted
}

func (m mcpBriefings) Briefing(ctx context.Context, tenantID, slug, id string, session *privacy.Session) (*analyst.Assistance, error) {
	type read struct {
		found analyst.Neighbourhood
		ok    bool
	}
	got, err := database.WithTenant(ctx, m.d.Pool, tenantID, func(ctx context.Context, q database.Querier) (read, error) {
		found, ok, err := analyst.Neighbours(ctx, analystsql.Reader{Q: q}, slug, id)
		return read{found, ok}, err
	})
	if err != nil || !got.ok {
		return nil, err
	}
	brief := analyst.OutsideBriefing(ctx, m.assisted, session, tenantID, got.found, mcpClock(m.d)())
	return &brief, nil
}

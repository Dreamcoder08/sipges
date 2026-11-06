package app

import (
	"context"
	"errors"
	"net/http"
	"os"
	"time"

	analyst "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	analystdomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	analysthttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/http"
	analystsql "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/infrastructure"
	ontology "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/application"
	ontologydomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
	ontologysql "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/config"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
	recordsdomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	recordssql "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/infrastructure"
)

func init() {
	registerContext("analyst", func(d Deps) (func(*http.ServeMux), error) {
		assisted, err := assistedBriefing(d)
		if err != nil {
			return nil, err
		}
		options := analysthttp.Options{
			DB: d.Pool, Now: d.Now, Logger: d.Logger, Assisted: assisted,
			Deciding: analyst.Deciding{Actions: proposalActions{d}, Store: analystsql.Decisions{DB: d.Pool}, Now: d.Now},
		}
		return func(mux *http.ServeMux) { analysthttp.Routes(mux, options) }, nil
	})
}

// assistedBriefing is the narrator; nil unless SIPGES_ANALYST_PROVIDER configures one. Without
// SIPGES_DATA_KEY there is no guard, so the narrator gets nothing.
func assistedBriefing(d Deps) (*analyst.Assisted, error) {
	settings, err := config.LoadAnalyst(os.LookupEnv)
	if err != nil || !settings.Enabled {
		return nil, err
	}
	assisted := &analyst.Assisted{Narrator: analystsql.NewClaude(settings.Model, os.LookupEnv), Logger: d.Logger}
	guard, err := egressGuard(d)
	switch {
	case err == nil:
		assisted.Egress = guard
	case !errors.Is(err, config.ErrNoDataKey):
		return nil, err
	}
	return assisted, nil
}

// proposalActions writes an approved proposal through the ontology and records use cases, so it
// is validated and audited exactly as the same write from their own routes.
type proposalActions struct {
	d Deps
}

func (a proposalActions) now() time.Time {
	if a.d.Now != nil {
		return a.d.Now()
	}
	return time.Now()
}

// Link implements analyst.ProposalActions.
func (a proposalActions) Link(ctx context.Context, tenantID string, link analystdomain.ProposedLink, note, actor string) (string, error) {
	at := a.now().Truncate(time.Millisecond)
	return database.WithTenant(ctx, a.d.Pool, tenantID, func(ctx context.Context, q database.Querier) (string, error) {
		writes := ontology.Writes{Store: ontologysql.Store{Q: q}, Now: at}
		_, problem, err := writes.Link(ctx, ontology.LinkInput{
			LinkType: link.LinkType,
			Source:   ontologydomain.Ref{Module: link.Source.Slug, ID: link.Source.ID},
			Target:   ontologydomain.Ref{Module: link.Target.Slug, ID: link.Target.ID},
			Note:     note,
		}, actor)
		switch {
		case err != nil:
			return "", err
		case problem == "":
			return analyst.LinkCreated, nil
		case problem == string(ontology.Duplicate):
			return analyst.LinkDuplicate, nil
		}
		return analyst.LinkFailed, nil
	})
}

// Create implements analyst.ProposalActions.
func (a proposalActions) Create(ctx context.Context, tenantID string, record analystdomain.ProposedRecord) (string, error) {
	module, ok := recordsdomain.ModuleForSlug(record.Slug)
	if !ok {
		return "", nil
	}
	payload := recordsdomain.NewObject()
	for _, field := range record.Payload {
		payload.Set(field.Key, field.Value)
	}
	writes := records.Writes{Store: recordssql.Records{DB: a.d.Pool}, Now: a.now, RandomHex: randomHexUpper}
	id, problem, err := writes.Create(ctx, tenantID, module, payload)
	switch {
	case errors.Is(err, records.ErrExhausted), problem != nil:
		return "", nil
	case err != nil:
		return "", err
	}
	return id, nil
}

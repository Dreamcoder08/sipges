package app

import (
	"context"
	"net/http"

	evidence "github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/application"
	evidencedomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/domain"
	evidencesql "github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/infrastructure"
	intelligence "github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/application"
	intelligencesql "github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	prevention "github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/application"
	preventiondomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/domain"
	preventionhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/http"
	preventionsql "github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/infrastructure"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

func init() {
	registerContext("prevention", func(d Deps) (func(*http.ServeMux), error) {
		service := prevention.Service{
			Store:     preventionsql.Actions{DB: d.Pool},
			Alerts:    alertLookup{intelligence.Service{Store: intelligencesql.Alerts{DB: d.Pool}}},
			Evidence:  evidenceLookup{d.Pool},
			RandomHex: randomHexUpper,
			Now:       d.Now,
		}
		return func(mux *http.ServeMux) {
			preventionhttp.Routes(mux, service, d.Logger)
			preventionhttp.WriteRoutes(mux, service, d.Logger)
		}, nil
	})
}

// alertLookup and evidenceLookup read other contexts for the scope's tenant only, as compose.ts
// wires them (ADR 0002). Body strings keep lone surrogates, which reach PostgreSQL as U+FFFD.
type alertLookup struct{ alerts intelligence.Service }

func (l alertLookup) Status(ctx context.Context, scope tenancy.Scope, id string) (*string, error) {
	alert, err := l.alerts.GetAlert(ctx, scope, records.WellFormed(id))
	if err != nil || alert == nil {
		return nil, err
	}
	return &alert.Status, nil
}

type evidenceLookup struct{ db database.Beginner }

func (l evidenceLookup) Find(ctx context.Context, scope tenancy.Scope, id string) (*preventiondomain.DecisionReceipt, error) {
	id = records.WellFormed(id)
	if !evidence.ValidID(id) {
		return nil, nil
	}
	file, err := database.WithTenant(ctx, l.db, scope.TenantID(), func(ctx context.Context, q database.Querier) (*evidencedomain.Attachment, error) {
		return evidencesql.Get(ctx, q, id)
	})
	if err != nil || file == nil {
		return nil, err
	}
	return &preventiondomain.DecisionReceipt{AttachmentID: file.ID, FileName: file.OriginalName, SHA256: file.SHA256}, nil
}

package app

import (
	"context"
	"net/http"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analytics/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analytics/domain"
	analyticshttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/analytics/http"
	analyticssql "github.com/Dreamcoder08/sipges/apps/api-go/internal/analytics/infrastructure"
	indicatorssql "github.com/Dreamcoder08/sipges/apps/api-go/internal/indicators/infrastructure"
	intelligencesql "github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/infrastructure"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// riskAlertLimit is the 100_000 of allAlerts: every alert of the project, for the back-test.
const riskAlertLimit = 100_000

// riskSources joins the prediction to intelligence and indicators, as compose.ts does: analytics
// sees neither context, only the fields it reads.
type riskSources struct {
	records analyticssql.DatedRecords
	alerts  intelligencesql.Alerts
	history indicatorssql.Store
}

func (s riskSources) Records(ctx context.Context, scope tenancy.Scope, modules []string) ([]domain.RiskRecord, error) {
	return s.records.Read(ctx, scope.TenantID(), modules)
}

func (s riskSources) Alerts(ctx context.Context, scope tenancy.Scope) ([]domain.RiskAlert, error) {
	alerts, err := s.alerts.List(ctx, scope.TenantID(), scope.ProjectID, riskAlertLimit)
	if err != nil {
		return nil, err
	}
	out := make([]domain.RiskAlert, len(alerts))
	for i, a := range alerts {
		out[i] = domain.RiskAlert{
			ID: a.ID, CreatedAt: domain.ISOMillis(a.CreatedAt), Territory: a.Territory, Level: a.Level, Status: a.Status,
		}
		if a.ReviewedAt != nil {
			reviewed := domain.ISOMillis(*a.ReviewedAt)
			out[i].ReviewedAt = &reviewed
		}
	}
	return out, nil
}

func (s riskSources) IRSA(ctx context.Context, scope tenancy.Scope) ([]domain.IrsaPoint, error) {
	snapshots, err := s.history.History(ctx, scope.TenantID(), nil)
	if err != nil {
		return nil, err
	}
	out := make([]domain.IrsaPoint, len(snapshots))
	for i, p := range snapshots {
		out[i] = domain.IrsaPoint{TS: p.TS, Irsa: p.Irsa}
	}
	return out, nil
}

func init() {
	registerContext("conflict_risk", func(d Deps) (func(*http.ServeMux), error) {
		return func(mux *http.ServeMux) {
			analyticshttp.ConflictRiskRoutes(mux, application.ConflictRisk{
				Sources: riskSources{
					records: analyticssql.DatedRecords{DB: d.Pool},
					alerts:  intelligencesql.Alerts{DB: d.Pool},
					history: indicatorssql.Store{DB: d.Pool},
				},
				Engine: d.Engines.Analytics,
				Now:    d.Now,
			}, d.Logger)
		}, nil
	})
}

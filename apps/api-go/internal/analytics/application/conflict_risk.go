package application

import (
	"context"
	"encoding/json"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analytics/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// RiskSources is ConflictRiskSources of ports.ts: the scope's dated inputs of the prediction.
type RiskSources interface {
	Records(ctx context.Context, scope tenancy.Scope, modules []string) ([]domain.RiskRecord, error)
	Alerts(ctx context.Context, scope tenancy.Scope) ([]domain.RiskAlert, error)
	IRSA(ctx context.Context, scope tenancy.Scope) ([]domain.IrsaPoint, error)
}

// ConflictRisk is createConflictRiskService (docs/adr/0031): it reads the scope's sources, then
// runs the conflict_risk operation of the Rust analytics module.
type ConflictRisk struct {
	Sources RiskSources
	Engine  Engine
	// Now is the clock of the prediction day; nil means time.Now.
	Now func() time.Time
}

type riskRequest struct {
	Op      string              `json:"op"`
	Records []domain.RiskRecord `json:"records"`
	Alerts  []domain.RiskAlert  `json:"alerts"`
	IRSA    []domain.IrsaPoint  `json:"irsa"`
	Today   string              `json:"today"`
}

// Predict is predict(scope).
func (c ConflictRisk) Predict(ctx context.Context, scope tenancy.Scope) (json.RawMessage, error) {
	records, err := c.Sources.Records(ctx, scope, domain.RiskModules)
	if err != nil {
		return nil, err
	}
	alerts, err := c.Sources.Alerts(ctx, scope)
	if err != nil {
		return nil, err
	}
	irsa, err := c.Sources.IRSA(ctx, scope)
	if err != nil {
		return nil, err
	}
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	body, err := json.Marshal(riskRequest{
		Op: "conflict_risk", Records: records, Alerts: alerts, IRSA: irsa, Today: domain.LimaToday(now()),
	})
	if err != nil {
		return nil, err
	}
	return c.Engine.Call(ctx, body)
}

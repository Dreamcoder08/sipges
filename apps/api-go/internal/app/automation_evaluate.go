package app

import (
	"context"
	"strings"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
	intelligence "github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/application"
	intelligencesql "github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/infrastructure"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// narrativeEvaluator joins the automation tick to the intelligence context, as compose.ts does:
// evaluation is rules only, so it needs neither the embedder nor the egress guard. The engine is
// read at each evaluation, as the routes read it when they mount.
func narrativeEvaluator(d Deps) application.NarrativeEvaluator {
	return func(ctx context.Context, tenantID string, event domain.Event, minimumLevel string) error {
		company, project, ok := strings.Cut(tenantID, "/")
		if !ok || event.RecordID == nil || event.Record == nil {
			return nil
		}
		creation := intelligence.AlertCreation{
			Semantic: &intelligence.Semantic{Text: intelligence.Writes{
				Engine: d.Engines.Analytics, Narratives: intelligencesql.Narratives{DB: d.Pool}, Now: d.Now,
			}},
			Store: intelligencesql.Alerts{DB: d.Pool}, Now: d.Now, RandomHex: randomHexUpper,
		}
		payload, _ := event.Record.Payload.(*records.Object)
		_, err := creation.EvaluateNarrative(ctx, tenancy.Scope{CompanyID: company, ProjectID: project}, intelligence.NarrativeInput{
			ID: *event.RecordID, Marking: event.Record.Marking, MinimumLevel: minimumLevel,
			Payload: func(key string) (any, bool) {
				if payload == nil {
					return nil, false
				}
				return payload.Get(key)
			},
		})
		return err
	}
}

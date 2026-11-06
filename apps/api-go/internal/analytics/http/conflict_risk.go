package http

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analytics/application"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// ConflictRiskRoutes registers GET /system/conflict-risk (conflict-risk-routes.ts, docs/adr/0031):
// always for the scope the tenancy middleware resolved.
func ConflictRiskRoutes(mux *http.ServeMux, service application.ConflictRisk, log *slog.Logger) {
	mux.HandleFunc("GET /system/conflict-risk", handle(log, func(ctx context.Context, scope tenancy.Scope) ([]byte, error) {
		return service.Predict(ctx, scope)
	}))
}

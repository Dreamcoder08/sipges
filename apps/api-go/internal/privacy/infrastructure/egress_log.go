package infrastructure

import (
	"context"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/audittrail"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
)

// The module and action under which every egress shows in Auditoría.
const (
	AuditModule = "IA externa"
	AuditAction = "EGRESS"
)

// EgressLog is the append-only audit trail of the project: one row per release, no payload values.
type EgressLog struct {
	DB database.Beginner
}

// Append writes the row in a tenant transaction of its own.
func (l EgressLog) Append(ctx context.Context, tenantID string, entry application.EgressLogEntry) error {
	_, err := database.WithTenant(ctx, l.DB, tenantID, func(ctx context.Context, q database.Querier) (struct{}, error) {
		err := audittrail.Append(ctx, q, audittrail.Entry{
			At: entry.At, Module: AuditModule, Action: AuditAction, Detail: domain.WellFormed(entry.Detail),
		})
		return struct{}{}, err
	})
	return err
}

package infrastructure

import (
	"context"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
)

// The module and action under which every egress shows in Auditoría.
const (
	AuditModule = "IA externa"
	AuditAction = "EGRESS"
)

// appendAudit is appendAudit of apps/api/src/platform/database/audit-trail.ts.
const appendAudit = `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5)`

// EgressLog is the append-only audit trail of the project: one row per release, no payload values.
type EgressLog struct {
	DB database.Beginner
}

// Append writes the row in a tenant transaction of its own.
func (l EgressLog) Append(ctx context.Context, tenantID string, entry application.EgressLogEntry) error {
	_, err := database.WithTenant(ctx, l.DB, tenantID, func(ctx context.Context, q database.Querier) (struct{}, error) {
		_, err := q.Exec(ctx, appendAudit, entry.At, AuditModule, nil, AuditAction, domain.WellFormed(entry.Detail))
		return struct{}{}, err
	})
	return err
}

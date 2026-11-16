package infrastructure

import (
	"context"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// startCursorIfMissing creates the tenant's cursor at the current audit head and leaves an
// existing one untouched, unlike startCursor (writes.go), which may move it forward.
const startCursorIfMissing = `INSERT INTO automation_cursors (tenant_id, last_audit_id)
           SELECT current_setting('app.tenant_id', true), COALESCE(max(id), 0) FROM audit
           ON CONFLICT (tenant_id) DO NOTHING`

// StartCursorIfMissing is the automation cursor write other contexts need (integration, when a
// media feed or an official source is switched on), run in the caller's tenant transaction.
// Automation owns automation_cursors (ADR 0002); the composition root wires this function in.
func StartCursorIfMissing(ctx context.Context, q database.Querier) error {
	_, err := q.Exec(ctx, startCursorIfMissing)
	return err
}

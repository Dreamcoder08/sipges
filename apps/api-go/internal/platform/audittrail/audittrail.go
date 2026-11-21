// Package audittrail is the one writer of the audit table: appendAudit of
// apps/api/src/platform/database/audit-trail.ts. The audit trail is cross-cutting, not a
// context, so every context appends through this package instead of writing the table itself
// (ADR 0002; odd/archive/go-context-ports.md T1).
package audittrail

import (
	"context"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// appendSQL takes the tenant from the transaction-local app.tenant_id, never from the caller.
const appendSQL = `INSERT INTO audit (tenant_id, ts, module, record_id, action, detail, event_payload)
     VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4, $5, $6::jsonb)`

// Entry is one audit row. The caller normalizes Detail (and RecordID) as its context requires;
// Append stores them as given.
type Entry struct {
	At     time.Time
	Module string
	// RecordID nil stores NULL; a pointer to "" stores the empty string.
	RecordID *string
	Action   string
	Detail   string
	// Payload is the event_payload JSON; nil stores NULL.
	Payload []byte
}

// Append writes e inside the caller's transaction q, so the business write and its audit row
// commit or roll back together.
func Append(ctx context.Context, q database.Querier, e Entry) error {
	var payload any
	if e.Payload != nil {
		payload = string(e.Payload)
	}
	_, err := q.Exec(ctx, appendSQL, e.At, e.Module, e.RecordID, e.Action, e.Detail, payload)
	return err
}

// ID returns a pointer to id, for a RecordID that is always present.
func ID(id string) *string {
	return &id
}

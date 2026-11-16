package application

import (
	"context"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// InTxWriter is how other contexts change a record (ADR 0002: records owns module_records). Both
// writes run in the caller's tenant transaction, so row-level security, the row lock the caller
// already holds and its audit row commit or roll back together.
type InTxWriter interface {
	// ReplacePayload stores payload (JSON text) as the record's payload and stamps updated_at.
	ReplacePayload(ctx context.Context, q database.Querier, module, id, payload string, at time.Time) error
	// SetMarking sets the record's marking; updated_at is left as it was.
	SetMarking(ctx context.Context, q database.Querier, module, id, marking string) error
}

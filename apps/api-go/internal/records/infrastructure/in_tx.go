package infrastructure

import (
	"context"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
)

// The statements evidence (attach) and ontology (setMarking) ran on module_records before
// records owned them; unchanged, so every stored value stays the same.
const (
	replacePayloadInTx = `UPDATE module_records SET payload = $3::jsonb, updated_at = $4
    WHERE module = $1 AND id = $2`
	setMarkingInTx = `UPDATE module_records SET marking = $3 WHERE module = $1 AND id = $2`
)

// InTx is records' application.InTxWriter.
type InTx struct{}

var _ application.InTxWriter = InTx{}

// ReplacePayload is application.InTxWriter.ReplacePayload.
func (InTx) ReplacePayload(ctx context.Context, q database.Querier, module, id, payload string, at time.Time) error {
	_, err := q.Exec(ctx, replacePayloadInTx, module, id, payload, at)
	return err
}

// SetMarking is application.InTxWriter.SetMarking.
func (InTx) SetMarking(ctx context.Context, q database.Querier, module, id, marking string) error {
	_, err := q.Exec(ctx, setMarkingInTx, module, id, marking)
	return err
}

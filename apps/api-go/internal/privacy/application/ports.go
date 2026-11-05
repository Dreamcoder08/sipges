package application

import (
	"context"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
)

// Switch is the project's «Envío a IA externa» switch; off until an administrator turns it on.
type Switch interface {
	Enabled(ctx context.Context, tenantID string) (bool, error)
}

// NameDirectory gives the project's own people and organisations, read with full clearance so
// none is missed.
type NameDirectory interface {
	Load(ctx context.Context, tenantID string) ([]domain.KnownName, error)
}

// EgressLogEntry is one line of the access log: what left, never its content.
type EgressLogEntry struct {
	Detail string
	At     time.Time
}

// EgressLog appends to the project's audit trail; it fails the release when it cannot write.
type EgressLog interface {
	Append(ctx context.Context, tenantID string, entry EgressLogEntry) error
}

// PseudonymKeys gives the per-project keyed hash derived from SIPGES_DATA_KEY; the key itself
// never leaves the adapter.
type PseudonymKeys interface {
	MacFor(tenantID string) domain.Mac
}

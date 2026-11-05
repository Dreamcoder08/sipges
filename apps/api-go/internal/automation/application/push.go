package application

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"
)

// redacted replaces a push value in logs and formatted errors: endpoints are capability URLs,
// keys are credentials and payloads carry personal data.
const redacted = "[redacted]"

// PushSubscription is PushSubscription: one browser's endpoint and encryption keys.
type PushSubscription struct {
	Endpoint string
	P256dh   string
	Auth     string
}

// String keeps the subscription out of formatted text.
func (PushSubscription) String() string { return redacted }

// GoString keeps the subscription out of %#v.
func (PushSubscription) GoString() string { return redacted }

// LogValue keeps the subscription out of structured logs.
func (PushSubscription) LogValue() slog.Value { return slog.StringValue(redacted) }

// MarshalJSON keeps the subscription out of encoded logs. The payload is encoded to be sent, so
// it cannot do the same.
func (PushSubscription) MarshalJSON() ([]byte, error) { return json.Marshal(redacted) }

// String keeps the payload out of formatted text.
func (PushPayload) String() string { return redacted }

// GoString keeps the payload out of %#v.
func (PushPayload) GoString() string { return redacted }

// LogValue keeps the payload out of structured logs.
func (PushPayload) LogValue() slog.Value { return slog.StringValue(redacted) }

// PushResult is what the push service answered: Sent, or Gone when the browser dropped the
// subscription.
type PushResult int

// Push results.
const (
	PushSent PushResult = iota
	PushGone
)

// PushSender is PushSender. Errors name the failure only, never the endpoint, keys or payload.
type PushSender interface {
	PublicKey() string
	Send(ctx context.Context, subscription PushSubscription, payload PushPayload, now time.Time) (PushResult, error)
}

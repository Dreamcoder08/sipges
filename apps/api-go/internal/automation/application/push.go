package application

import (
	"context"
	"encoding/json"
	"log/slog"
	"regexp"
	"strconv"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
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
// subscription. A failed send returns PushFailed, the zero value, with its error.
type PushResult int

// Push results.
const (
	PushFailed PushResult = iota
	PushSent
	PushGone
)

// PushSender is PushSender. Errors name the failure only, never the endpoint, keys or payload.
type PushSender interface {
	PublicKey() string
	Send(ctx context.Context, subscription PushSubscription, payload PushPayload, now time.Time) (PushResult, error)
}

// PushStore is the subscriptions part of PushStore: push_subscriptions is a global table, keyed
// by endpoint, reached with the owner connection.
type PushStore interface {
	Save(ctx context.Context, username string, subscription PushSubscription, at time.Time) error
	Remove(ctx context.Context, username, endpoint string) error
	// OwnTargets lists the subscriptions of one active person.
	OwnTargets(ctx context.Context, username string) ([]PushSubscription, error)
	// Forget drops a subscription the push service no longer knows.
	Forget(ctx context.Context, endpoint string) error
}

// PushState is pushState. receipt_confirmed is always false: nothing confirms delivery.
type PushState struct {
	Configured       bool `json:"configured"`
	Subscriptions    int  `json:"subscriptions"`
	ReceiptConfirmed bool `json:"receipt_confirmed"`
}

// PushTest is the answer of testPush.
type PushTest struct {
	Status   string `json:"status"`
	Accepted int    `json:"accepted"`
	Detail   string `json:"detail"`
}

// SubscribeError is why a subscription was refused.
type SubscribeError string

// Subscribe errors.
const (
	SubscribeDisabled SubscribeError = "disabled"
	SubscribeInvalid  SubscribeError = "invalid"
)

var (
	p256dhPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{80,100}$`)
	authPattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{16,32}$`)
)

// PushKey is pushKey: the VAPID public key browsers subscribe with; ok is false with push off.
func (s Service) PushKey() (string, bool) {
	if s.PushSender == nil {
		return "", false
	}
	return s.PushSender.PublicKey(), true
}

// PushState is pushState.
func (s Service) PushState(ctx context.Context, username string) (PushState, error) {
	targets, err := s.Subscriptions.OwnTargets(ctx, username)
	if err != nil {
		return PushState{}, err
	}
	return PushState{Configured: s.PushSender != nil, Subscriptions: len(targets)}, nil
}

// TestPush is testPush: one test message to each of the person's own devices, audited in the
// active project (no person is named). A failed device never stops the others.
func (s Service) TestPush(ctx context.Context, username, tenantID string) (PushTest, error) {
	if s.PushSender == nil {
		return PushTest{Status: "failed", Detail: "Push no configurado"}, nil
	}
	targets, err := s.Subscriptions.OwnTargets(ctx, username)
	if err != nil {
		return PushTest{}, err
	}
	if len(targets) == 0 {
		return PushTest{Status: "no_subscription", Detail: "No hay dispositivos suscritos para tu usuario"}, nil
	}
	payload := PushPayload{
		Title: "Prueba de SIPGES",
		Body:  "Prueba solicitada por tu usuario. Confirma la recepción en este dispositivo.",
		URL:   "/",
	}
	accepted, failed := 0, false
	for _, target := range targets {
		result, err := s.PushSender.Send(ctx, target, payload, s.now())
		switch {
		case err != nil:
			failed = true
		case result == PushGone:
			failed = true
			_ = s.Subscriptions.Forget(ctx, target.Endpoint) // the test already reports this device
		default:
			accepted++
		}
	}
	s.auditedAs(ctx, tenantID, "PUSH_SEND", "Prueba de push · "+strconv.Itoa(accepted)+" aceptados · "+
		strconv.Itoa(len(targets)-accepted)+" fallidos")
	if failed {
		return PushTest{Status: "failed", Accepted: accepted, Detail: "Uno o más proveedores rechazaron la prueba; revisa tu suscripción"}, nil
	}
	return PushTest{Status: "accepted", Accepted: accepted, Detail: "El proveedor aceptó la prueba. La recepción en el dispositivo aún debe confirmarse."}, nil
}

// SubscribePush is subscribePush.
func (s Service) SubscribePush(ctx context.Context, username string, subscription PushSubscription) (SubscribeError, error) {
	if s.PushSender == nil {
		return SubscribeDisabled, nil
	}
	if !domain.IsPushEndpoint(subscription.Endpoint) || !p256dhPattern.MatchString(subscription.P256dh) ||
		!authPattern.MatchString(subscription.Auth) {
		return SubscribeInvalid, nil
	}
	return "", s.Subscriptions.Save(ctx, username, subscription, s.now())
}

// UnsubscribePush is unsubscribePush: it removes the endpoint only when it is the caller's.
func (s Service) UnsubscribePush(ctx context.Context, username, endpoint string) error {
	return s.Subscriptions.Remove(ctx, username, endpoint)
}

// PushDelivery is one claimed row of push_deliveries.
type PushDelivery struct {
	ID           int64
	Subscription PushSubscription
	Payload      PushPayload
	Attempts     int64
}

// PushDeliveries is the delivery part of PushStore.
type PushDeliveries interface {
	// Claim leases the next due delivery of the tenant, if any: a row goes to one runner.
	Claim(ctx context.Context, tenantID string, at, leaseUntil time.Time) ([]PushDelivery, error)
	Finish(ctx context.Context, tenantID string, id int64, status, errText string, retryAt time.Time) error
}

// deliverPush is deliverPush: due deliveries one at a time, within the tick's budget. The check
// before each claim keeps a tick inside its budget plus one send, which the shutdown drain
// counts on. Delivery is at least once: the row is settled after the send, so a kill between
// the two repeats the push when its lease expires, and browsers do not deduplicate.
func (s Service) deliverPush(ctx context.Context, tenantID string, deadline time.Duration) error {
	if s.PushSender == nil || s.Deliveries == nil {
		return nil
	}
	for count := 0; count < DeliveryBatch && s.mono() < deadline; count++ {
		at := s.now()
		deliveries, err := s.Deliveries.Claim(ctx, tenantID, at, at.Add(LeaseSeconds*time.Second))
		if err != nil {
			return err
		}
		if len(deliveries) == 0 {
			return nil
		}
		for _, d := range deliveries {
			if err := s.deliverOne(ctx, tenantID, d); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s Service) deliverOne(ctx context.Context, tenantID string, d PushDelivery) error {
	audit := func(outcome string) {
		s.auditedAs(ctx, tenantID, "PUSH_SEND", "Envío push · entrega "+strconv.FormatInt(d.ID, 10)+" · "+outcome)
	}
	result, err := s.PushSender.Send(ctx, d.Subscription, d.Payload, s.now())
	if err != nil {
		audit("fallido")
		return s.retryDelivery(ctx, tenantID, d, err)
	}
	if result == PushSent {
		// Audited before any bookkeeping, so a send that happened always leaves its row.
		audit("aceptado")
		finish := func() error { return s.Deliveries.Finish(ctx, tenantID, d.ID, "accepted", "", s.now()) }
		if finish() != nil {
			// The push went out: unlike TypeScript's catch, it is not queued to go out again.
			return finish()
		}
		return nil
	}
	audit("expirado")
	if err := s.Subscriptions.Forget(ctx, d.Subscription.Endpoint); err != nil {
		return s.retryDelivery(ctx, tenantID, d, err)
	}
	if err := s.Deliveries.Finish(ctx, tenantID, d.ID, "failed", "Suscripción expirada", s.now()); err != nil {
		return s.retryDelivery(ctx, tenantID, d, err)
	}
	return nil
}

// retryDelivery settles a delivery that failed: pending at its next delay, failed when its
// attempts ran out.
func (s Service) retryDelivery(ctx context.Context, tenantID string, d PushDelivery, cause error) error {
	delay, retry := domain.RetryDelayMinutes(d.Attempts)
	status := "failed"
	if retry {
		status = "pending"
	}
	return s.Deliveries.Finish(ctx, tenantID, d.ID, status, errorText(cause),
		s.now().Add(time.Duration(delay)*time.Minute))
}

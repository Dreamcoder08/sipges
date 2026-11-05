package application

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// fakeWrites scans and delivers nothing and records audit rows.
type fakeWrites struct {
	Writes
	audits *[]string
}

func (f fakeWrites) Scan(context.Context, database.Querier, int, time.Time) (int64, int64, error) {
	return 0, 0, nil
}

func (f fakeWrites) ClaimDue(context.Context, database.Querier, int, time.Time, time.Time, []string) ([]ClaimedRun, error) {
	return nil, nil
}

func (f fakeWrites) AppendAudit(_ context.Context, _ database.Querier, e AuditEntry) error {
	*f.audits = append(*f.audits, e.Action+" "+e.Detail)
	return nil
}

type finished struct {
	id     int64
	status string
	text   string
}

type fakeDeliveries struct {
	pending    []PushDelivery
	claims     int
	claimErr   error
	finishes   []finished
	finishErrs []error
}

func (f *fakeDeliveries) Claim(context.Context, string, time.Time, time.Time) ([]PushDelivery, error) {
	f.claims++
	if f.claimErr != nil {
		return nil, f.claimErr
	}
	if len(f.pending) == 0 {
		return nil, nil
	}
	next := f.pending[:1]
	f.pending = f.pending[1:]
	return next, nil
}

func (f *fakeDeliveries) Finish(_ context.Context, _ string, id int64, status, text string, _ time.Time) error {
	f.finishes = append(f.finishes, finished{id, status, text})
	if len(f.finishErrs) > 0 {
		err := f.finishErrs[0]
		f.finishErrs = f.finishErrs[1:]
		return err
	}
	return nil
}

type fakePushStore struct {
	PushStore
	forgotten []string
	forgetErr error
}

func (f *fakePushStore) Forget(_ context.Context, endpoint string) error {
	f.forgotten = append(f.forgotten, endpoint)
	return f.forgetErr
}

type fakePushSender struct {
	result PushResult
	err    error
	sent   int
}

func (*fakePushSender) PublicKey() string { return "synthetic" }

func (f *fakePushSender) Send(context.Context, PushSubscription, PushPayload, time.Time) (PushResult, error) {
	f.sent++
	return f.result, f.err
}

type pushFixture struct {
	service    Service
	deliveries *fakeDeliveries
	store      *fakePushStore
	sender     *fakePushSender
	audits     *[]string
}

func pushService(sender *fakePushSender, pending ...PushDelivery) pushFixture {
	audits := &[]string{}
	f := pushFixture{deliveries: &fakeDeliveries{pending: pending}, store: &fakePushStore{}, sender: sender, audits: audits}
	f.service = Service{
		Store: fakeWrites{audits: audits},
		InTenant: func(ctx context.Context, _ string, fn func(context.Context, database.Querier) error) error {
			return fn(ctx, nil)
		},
		Deliveries:    f.deliveries,
		Subscriptions: f.store,
		PushSender:    sender,
		Now:           func() time.Time { return time.Unix(1_800_000_000, 0) },
	}
	return f
}

func queued(id, attempts int64) PushDelivery {
	return PushDelivery{ID: id, Attempts: attempts, Subscription: PushSubscription{Endpoint: "https://push.example.test/device"}}
}

func TestAcceptedDeliveryIsFinishedAndAudited(t *testing.T) {
	f := pushService(&fakePushSender{result: PushSent}, queued(7, 1))
	if _, err := f.service.Tick(t.Context(), "T"); err != nil {
		t.Fatal(err)
	}
	if want := []finished{{7, "accepted", ""}}; !slices.Equal(f.deliveries.finishes, want) {
		t.Fatalf("finishes %v", f.deliveries.finishes)
	}
	if want := []string{"PUSH_SEND Envío push · entrega 7 · aceptado"}; !slices.Equal(*f.audits, want) {
		t.Fatalf("audits %v", *f.audits)
	}
}

func TestGoneDeliveryForgetsTheDevice(t *testing.T) {
	f := pushService(&fakePushSender{result: PushGone}, queued(7, 1))
	if _, err := f.service.Tick(t.Context(), "T"); err != nil {
		t.Fatal(err)
	}
	if want := []finished{{7, "failed", "Suscripción expirada"}}; !slices.Equal(f.deliveries.finishes, want) {
		t.Fatalf("finishes %v", f.deliveries.finishes)
	}
	if !slices.Equal(f.store.forgotten, []string{"https://push.example.test/device"}) {
		t.Fatalf("forgotten %v", f.store.forgotten)
	}
	if want := []string{"PUSH_SEND Envío push · entrega 7 · expirado"}; !slices.Equal(*f.audits, want) {
		t.Fatalf("audits %v", *f.audits)
	}
}

func TestFailedDeliveryRetriesUntilItsAttemptsRunOut(t *testing.T) {
	failure := errors.New("Servicio de push: respuesta HTTP 500")
	for attempts, want := range map[int64]string{1: "pending", domain.MaxAttempts - 1: "pending", domain.MaxAttempts: "failed"} {
		f := pushService(&fakePushSender{err: failure}, queued(7, attempts))
		if _, err := f.service.Tick(t.Context(), "T"); err != nil {
			t.Fatal(err)
		}
		if got := []finished{{7, want, failure.Error()}}; !slices.Equal(f.deliveries.finishes, got) {
			t.Fatalf("attempts %d: finishes %v", attempts, f.deliveries.finishes)
		}
		if got := []string{"PUSH_SEND Envío push · entrega 7 · fallido"}; !slices.Equal(*f.audits, got) {
			t.Fatalf("audits %v", *f.audits)
		}
	}
}

// TypeScript's catch retries a send that was accepted when its bookkeeping fails; browsers do
// not deduplicate, so here the person would see the message twice.
func TestAcceptedSendIsNeverQueuedAgainWhenItsFinishFails(t *testing.T) {
	f := pushService(&fakePushSender{result: PushSent}, queued(7, 1))
	f.deliveries.finishErrs = []error{errors.New("connection reset")}
	if _, err := f.service.Tick(t.Context(), "T"); err != nil {
		t.Fatal(err)
	}
	for _, finish := range f.deliveries.finishes {
		if finish.status != "accepted" {
			t.Fatalf("finishes %v", f.deliveries.finishes)
		}
	}
	if len(f.deliveries.finishes) != 2 {
		t.Fatalf("finishes %v", f.deliveries.finishes)
	}
	if want := []string{"PUSH_SEND Envío push · entrega 7 · aceptado"}; !slices.Equal(*f.audits, want) {
		t.Fatalf("a sent push must be audited once: %v", *f.audits)
	}
}

func TestDeadDeviceWhoseForgetFailsIsRetried(t *testing.T) {
	f := pushService(&fakePushSender{result: PushGone}, queued(7, 1))
	f.store.forgetErr = errors.New("connection reset")
	if _, err := f.service.Tick(t.Context(), "T"); err != nil {
		t.Fatal(err)
	}
	if want := []finished{{7, "pending", "connection reset"}}; !slices.Equal(f.deliveries.finishes, want) {
		t.Fatalf("finishes %v", f.deliveries.finishes)
	}
}

func TestPushDeliveryStaysOffWithoutASender(t *testing.T) {
	f := pushService(&fakePushSender{}, queued(7, 1))
	f.service.PushSender = nil
	if _, err := f.service.Tick(t.Context(), "T"); err != nil {
		t.Fatal(err)
	}
	if f.deliveries.claims != 0 {
		t.Fatal("claimed a delivery no sender can send")
	}
}

func TestPushDeliveryRespectsTheBudget(t *testing.T) {
	f := pushService(&fakePushSender{result: PushSent}, queued(1, 1), queued(2, 1), queued(3, 1))
	clock := time.Duration(0)
	f.service.Monotonic = func() time.Duration { return clock }
	f.service.ExecutionBudget = 10 * time.Second
	sender := f.sender
	f.service.PushSender = advancing{sender, func() { clock += 6 * time.Second }}
	if _, err := f.service.Tick(t.Context(), "T"); err != nil {
		t.Fatal(err)
	}
	if sender.sent != 2 {
		t.Fatalf("%d sends: the check before each claim bounds the tick", sender.sent)
	}
}

type advancing struct {
	*fakePushSender
	tick func()
}

func (a advancing) Send(ctx context.Context, s PushSubscription, p PushPayload, at time.Time) (PushResult, error) {
	a.tick()
	return a.fakePushSender.Send(ctx, s, p, at)
}

func TestFailedClaimFailsTheTick(t *testing.T) {
	f := pushService(&fakePushSender{})
	f.deliveries.claimErr = errors.New("connection reset")
	if _, err := f.service.Tick(t.Context(), "T"); err == nil {
		t.Fatal("expected the tick to fail")
	}
}

func TestPushResultHasNoSuccessfulZeroValue(t *testing.T) {
	var zero PushResult
	if zero == PushSent || zero == PushGone {
		t.Fatal("a failed send returns the zero value")
	}
}

func TestUnreadableDeliveryFailsAloneAndIsNeverSent(t *testing.T) {
	corrupt := queued(7, 1)
	corrupt.Unreadable = true
	f := pushService(&fakePushSender{result: PushSent}, corrupt, queued(8, 1))
	if _, err := f.service.Tick(t.Context(), "T"); err != nil {
		t.Fatal(err)
	}
	if f.sender.sent != 1 {
		t.Fatalf("%d sends: only the readable delivery goes out", f.sender.sent)
	}
	want := []finished{{7, "failed", "Contenido push no válido"}, {8, "accepted", ""}}
	if !slices.Equal(f.deliveries.finishes, want) {
		t.Fatalf("finishes %v", f.deliveries.finishes)
	}
	if got := (*f.audits)[0]; got != "PUSH_SEND Envío push · entrega 7 · fallido" {
		t.Fatalf("audit %q", got)
	}
}

func TestAResultItCannotReadNeverForgetsTheDevice(t *testing.T) {
	f := pushService(&fakePushSender{result: PushFailed}, queued(7, 1))
	if _, err := f.service.Tick(t.Context(), "T"); err != nil {
		t.Fatal(err)
	}
	if len(f.store.forgotten) != 0 {
		t.Fatalf("forgotten %v", f.store.forgotten)
	}
	if want := []finished{{7, "pending", "Servicio de push: resultado no válido"}}; !slices.Equal(f.deliveries.finishes, want) {
		t.Fatalf("finishes %v", f.deliveries.finishes)
	}
}

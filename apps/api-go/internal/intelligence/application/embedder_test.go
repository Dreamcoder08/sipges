package application_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/application"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

var scope = tenancy.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-SECHURA"}

type fakeEmbedder struct {
	egress string
	calls  atomic.Int32
	embed  func(ctx context.Context, call int32, text string) error
}

func (f *fakeEmbedder) Model() string  { return "fake-embed" }
func (f *fakeEmbedder) Egress() string { return f.egress }
func (f *fakeEmbedder) Embed(ctx context.Context, text privacy.Sanitised[string]) ([]float64, error) {
	call := f.calls.Add(1)
	if f.embed != nil {
		if err := f.embed(ctx, call, text.Value()); err != nil {
			return nil, err
		}
	}
	return []float64{1, 0, 0, 0, 0, 0, 0, 0.1}, nil
}

type fakeSwitch struct {
	on     bool
	err    error
	tenant string
}

func (f *fakeSwitch) Enabled(_ context.Context, tenant string) (bool, error) {
	f.tenant = tenant
	return f.on, f.err
}

type clock struct{ at atomic.Int64 }

func (c *clock) now() time.Time { return time.Unix(c.at.Load(), 0) }

func probeOf(e application.Embedder, s privacy.Switch, c *clock) *application.EmbedderProbe {
	return application.NewEmbedderProbe(e, s, c.now)
}

func status(t *testing.T, p *application.EmbedderProbe) application.EmbedderStatus {
	t.Helper()
	got, err := p.Status(t.Context(), scope)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestReachableEmbedder(t *testing.T) {
	t.Parallel()
	fake := &fakeEmbedder{egress: "local", embed: func(_ context.Context, _ int32, text string) error {
		if text != "sipges" {
			t.Errorf("probe text = %q", text)
		}
		return nil
	}}
	got := status(t, probeOf(fake, &fakeSwitch{}, &clock{}))
	want := application.EmbedderStatus{Available: true, Model: "fake-embed", Egress: "local"}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestUnreachableEmbedder(t *testing.T) {
	t.Parallel()
	fake := &fakeEmbedder{egress: "local", embed: func(context.Context, int32, string) error {
		return errors.New("offline")
	}}
	got := status(t, probeOf(fake, &fakeSwitch{}, &clock{}))
	if got.Available || got.Reason != application.ReasonUnreachable {
		t.Fatalf("got %+v", got)
	}
}

func TestLocalEmbedderNeverReadsTheSwitch(t *testing.T) {
	t.Parallel()
	fake := &fakeEmbedder{egress: "local"}
	sw := &fakeSwitch{err: errors.New("must not be read")}
	if got := status(t, probeOf(fake, sw, &clock{})); !got.Available {
		t.Fatalf("got %+v", got)
	}
}

func TestExternalEmbedderIsNotProbedWhileTheSwitchIsOff(t *testing.T) {
	t.Parallel()
	fake := &fakeEmbedder{egress: "external"}
	sw := &fakeSwitch{}
	got := status(t, probeOf(fake, sw, &clock{}))
	if got.Available || got.Reason != application.ReasonExternalAIDisabled || got.Egress != "external" {
		t.Fatalf("got %+v", got)
	}
	if fake.calls.Load() != 0 {
		t.Fatal("an external embedder was contacted with the switch off")
	}
	if sw.tenant != "SIPGES/PRJ-SECHURA" {
		t.Fatalf("switch read for %q", sw.tenant)
	}
}

func TestExternalEmbedderIsNotProbedWithoutASwitch(t *testing.T) {
	t.Parallel()
	fake := &fakeEmbedder{egress: "external"}
	got := status(t, application.NewEmbedderProbe(fake, nil, (&clock{}).now))
	if got.Reason != application.ReasonExternalAIDisabled || fake.calls.Load() != 0 {
		t.Fatalf("got %+v, %d calls", got, fake.calls.Load())
	}
}

func TestAnyEgressButLocalNeedsTheSwitch(t *testing.T) {
	t.Parallel()
	fake := &fakeEmbedder{egress: ""}
	got := status(t, probeOf(fake, &fakeSwitch{}, &clock{}))
	if got.Reason != application.ReasonExternalAIDisabled || fake.calls.Load() != 0 {
		t.Fatalf("got %+v, %d calls", got, fake.calls.Load())
	}
}

func TestExternalEmbedderIsProbedWithTheSwitchOn(t *testing.T) {
	t.Parallel()
	fake := &fakeEmbedder{egress: "external"}
	if got := status(t, probeOf(fake, &fakeSwitch{on: true}, &clock{})); !got.Available {
		t.Fatalf("got %+v", got)
	}
}

func TestAFailedSwitchReadIsAnError(t *testing.T) {
	t.Parallel()
	fake := &fakeEmbedder{egress: "external"}
	probe := probeOf(fake, &fakeSwitch{err: errors.New("db down")}, &clock{})
	if _, err := probe.Status(t.Context(), scope); err == nil {
		t.Fatal("expected the error")
	}
	if fake.calls.Load() != 0 {
		t.Fatal("contacted the embedder on a failed switch read")
	}
}

func TestProbeIsCachedForSixtySeconds(t *testing.T) {
	t.Parallel()
	fake := &fakeEmbedder{egress: "local"}
	c := &clock{}
	probe := probeOf(fake, &fakeSwitch{}, c)
	status(t, probe)
	c.at.Store(59)
	status(t, probe)
	if fake.calls.Load() != 1 {
		t.Fatalf("calls = %d", fake.calls.Load())
	}
	c.at.Store(60)
	status(t, probe)
	if fake.calls.Load() != 2 {
		t.Fatalf("calls = %d", fake.calls.Load())
	}
}

func TestProbeIsRepeatedAfterAFailureExpires(t *testing.T) {
	t.Parallel()
	var up atomic.Bool
	fake := &fakeEmbedder{egress: "local", embed: func(context.Context, int32, string) error {
		if !up.Load() {
			return errors.New("offline")
		}
		return nil
	}}
	c := &clock{}
	probe := probeOf(fake, &fakeSwitch{}, c)
	if status(t, probe).Available {
		t.Fatal("offline")
	}
	up.Store(true)
	c.at.Store(61)
	if !status(t, probe).Available {
		t.Fatal("the failure was remembered")
	}
}

func TestLaterRequestDoesNotWaitForAProbeInFlight(t *testing.T) {
	t.Parallel()
	started := make(chan struct{})
	release := make(chan struct{})
	fake := &fakeEmbedder{egress: "local", embed: func(_ context.Context, call int32, _ string) error {
		if call == 1 {
			close(started)
			<-release
		}
		return nil
	}}
	probe := probeOf(fake, &fakeSwitch{}, &clock{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = probe.Status(context.Background(), scope)
	}()
	<-started
	finished := make(chan application.EmbedderStatus, 1)
	go func() {
		got, _ := probe.Status(context.Background(), scope)
		finished <- got
	}()
	select {
	case got := <-finished:
		if !got.Available {
			t.Errorf("got %+v", got)
		}
	case <-time.After(2 * time.Second):
		t.Error("the second request waited for the first probe")
	}
	close(release)
	<-done
}

func TestNewerAnswerSurvivesAnOlderProbe(t *testing.T) {
	t.Parallel()
	started := make(chan struct{})
	release := make(chan struct{})
	fake := &fakeEmbedder{egress: "local", embed: func(_ context.Context, call int32, _ string) error {
		if call == 1 {
			close(started)
			<-release
			return errors.New("offline")
		}
		return nil
	}}
	c := &clock{}
	probe := probeOf(fake, &fakeSwitch{}, c)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = probe.Status(context.Background(), scope)
	}()
	<-started
	c.at.Store(1)
	if !status(t, probe).Available {
		t.Fatal("newer probe")
	}
	close(release)
	<-done
	if !status(t, probe).Available {
		t.Fatal("the older failure replaced the newer answer")
	}
	if fake.calls.Load() != 2 {
		t.Fatalf("calls = %d", fake.calls.Load())
	}
}

func TestProbeIsCutAfterItsTimeout(t *testing.T) {
	t.Parallel()
	fake := &fakeEmbedder{egress: "local", embed: func(ctx context.Context, _ int32, _ string) error {
		<-ctx.Done()
		return ctx.Err()
	}}
	probe := probeOf(fake, &fakeSwitch{}, &clock{})
	probe.Timeout = 10 * time.Millisecond
	if got := status(t, probe); got.Available || got.Reason != application.ReasonUnreachable {
		t.Fatalf("got %+v", got)
	}
}

func TestACancelledRequestDoesNotCacheAFailure(t *testing.T) {
	t.Parallel()
	fake := &fakeEmbedder{egress: "local", embed: func(ctx context.Context, _ int32, _ string) error {
		return ctx.Err()
	}}
	probe := probeOf(fake, &fakeSwitch{}, &clock{})
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	got, err := probe.Status(ctx, scope)
	if err != nil || !got.Available {
		t.Fatalf("got %+v, %v", got, err)
	}
}

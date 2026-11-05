package app

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
)

// scripted answers each attempt from a list, then keeps succeeding.
type scripted struct {
	mu      sync.Mutex
	answers []error
	calls   int
}

func (s *scripted) attempt(context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.calls <= len(s.answers) {
		return s.answers[s.calls-1]
	}
	return nil
}

func newLoop(s *scripted, out *bytes.Buffer) (*IdentityBootstrap, *[]time.Duration) {
	waits := &[]time.Duration{}
	b := &IdentityBootstrap{
		attempt: s.attempt,
		log:     slog.New(slog.NewJSONHandler(out, nil)),
		sleep: func(ctx context.Context, d time.Duration) bool {
			*waits = append(*waits, d)
			return ctx.Err() == nil
		},
		done:   make(chan struct{}),
		failed: make(chan error, 1),
	}
	return b, waits
}

func wait(t *testing.T, b *IdentityBootstrap) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := b.Wait(ctx); err != nil {
		t.Fatalf("wait: %v", err)
	}
}

func TestBootstrapIsNotReadyUntilItSucceeds(t *testing.T) {
	var out bytes.Buffer
	transient := errors.New("connection refused")
	b, _ := newLoop(&scripted{answers: []error{transient}}, &out)
	if err := b.Ready(context.Background()); err == nil {
		t.Fatal("ready before starting")
	}
	b.Start(context.Background())
	wait(t, b)
	if err := b.Ready(context.Background()); err != nil {
		t.Fatalf("ready after success: %v", err)
	}
}

func TestBootstrapBacksOffUpToItsCap(t *testing.T) {
	var out bytes.Buffer
	transient := errors.New("connection refused")
	s := &scripted{answers: []error{transient, transient, transient, transient, transient, transient, transient, transient}}
	b, waits := newLoop(s, &out)
	b.Start(context.Background())
	wait(t, b)
	want := []time.Duration{1, 2, 4, 8, 16, 30, 30, 30}
	if len(*waits) != len(want) {
		t.Fatalf("waits %v", *waits)
	}
	for i, d := range want {
		if (*waits)[i] != d*time.Second {
			t.Fatalf("waits %v", *waits)
		}
	}
	if s.calls != 9 {
		t.Fatalf("calls %d", s.calls)
	}
}

func TestBootstrapStopsOnPermanentErrors(t *testing.T) {
	for _, permanent := range []error{application.ErrBootstrapPassword, application.ErrBootstrapUsername, application.ErrBootstrapGoogleEmail} {
		var out bytes.Buffer
		s := &scripted{answers: []error{permanent}}
		b, waits := newLoop(s, &out)
		b.Start(context.Background())
		select {
		case err := <-b.Failed():
			if !errors.Is(err, permanent) {
				t.Fatalf("err = %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no failure reported")
		}
		wait(t, b)
		if s.calls != 1 || len(*waits) != 0 {
			t.Fatalf("retried a permanent error: %d calls", s.calls)
		}
		if b.Ready(context.Background()) == nil {
			t.Fatal("ready after a permanent error")
		}
	}
}

func TestBootstrapNamesAnUnmigratedDatabaseOnEveryAttempt(t *testing.T) {
	for _, code := range []string{"42P01", "42703"} {
		var out bytes.Buffer
		missing := &pgconn.PgError{Code: code, Message: `relation "users" does not exist`, Detail: "synthetic-password"}
		b, _ := newLoop(&scripted{answers: []error{missing, missing, missing}}, &out)
		b.Start(context.Background())
		wait(t, b)
		if got := strings.Count(out.String(), `"msg":"`+msgUnmigrated+`"`); got != 3 {
			t.Fatalf("%s: logged %d times:\n%s", code, got, out.String())
		}
		if strings.Contains(out.String(), "synthetic-password") {
			t.Fatalf("error text reached the log: %s", out.String())
		}
	}
}

func TestBootstrapLogsOnlyTheClassOfOtherFailures(t *testing.T) {
	var out bytes.Buffer
	secret := errors.New("connect postgres://u:synthetic-password@h/db failed")
	coded := &pgconn.PgError{Code: "53300", Message: "synthetic-password"}
	b, _ := newLoop(&scripted{answers: []error{secret, coded}}, &out)
	b.Start(context.Background())
	wait(t, b)
	logs := out.String()
	if strings.Contains(logs, "synthetic-password") {
		t.Fatalf("error text reached the log: %s", logs)
	}
	if !strings.Contains(logs, `"sqlstate":"53300"`) || strings.Count(logs, msgRetry) != 2 {
		t.Fatalf("logs: %s", logs)
	}
}

func TestBootstrapStopsWhenCancelled(t *testing.T) {
	var out bytes.Buffer
	transient := errors.New("connection refused")
	b, _ := newLoop(&scripted{answers: []error{transient, transient, transient}}, &out)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	b.Start(ctx)
	wait(t, b)
	select {
	case err := <-b.Failed():
		t.Fatalf("a shutdown reported failure: %v", err)
	default:
	}
	if b.Ready(context.Background()) == nil {
		t.Fatal("ready after a cancelled bootstrap")
	}
}

func TestBootstrapWaitHonoursItsContext(t *testing.T) {
	b := &IdentityBootstrap{done: make(chan struct{}), failed: make(chan error, 1)}
	b.started.Store(true)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := b.Wait(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	unstarted := NewIdentityBootstrap(nil, func(string) (string, bool) { return "", false }, nil, nil)
	if err := unstarted.Wait(context.Background()); err != nil {
		t.Fatalf("a bootstrap never started must not hold the drain: %v", err)
	}
}

func TestBootstrapSettingsReadTheEnvironmentAsConfigTs(t *testing.T) {
	lookup := func(values map[string]string) func(string) (string, bool) {
		return func(k string) (string, bool) { v, ok := values[k]; return v, ok }
	}
	cases := []struct {
		env  map[string]string
		want bootstrapSettings
	}{
		{map[string]string{}, bootstrapSettings{admin: application.BootstrapAdmin{Username: "admin", FullName: "Administrator"}}},
		{
			map[string]string{"SIPGES_ADMIN_USERNAME": "  Root.Admin\t", "SIPGES_ADMIN_PASSWORD": "  keeps spaces  ", "SIPGES_ADMIN_FULL_NAME": " Ana "},
			bootstrapSettings{admin: application.BootstrapAdmin{Username: "root.admin", Password: "  keeps spaces  ", FullName: "Ana"}},
		},
		{map[string]string{"SIPGES_ADMIN_USERNAME": "", "SIPGES_ADMIN_FULL_NAME": " \ufeff "}, bootstrapSettings{admin: application.BootstrapAdmin{FullName: "Administrator"}}},
		{map[string]string{"SIPGES_GOOGLE_ADMIN_EMAIL": " A@b.co "}, bootstrapSettings{admin: application.BootstrapAdmin{Username: "admin", FullName: "Administrator"}, googleEmail: "A@b.co"}},
		{map[string]string{"SIPGES_GOOGLE_ADMIN_EMAIL": " \ufeff "}, bootstrapSettings{admin: application.BootstrapAdmin{Username: "admin", FullName: "Administrator"}}},
	}
	for _, c := range cases {
		if got := readBootstrapSettings(lookup(c.env)); got != c.want {
			t.Errorf("%v: got %+v", c.env, got)
		}
	}
}

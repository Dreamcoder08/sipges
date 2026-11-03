package dbping_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/dreamcoder08/sipges/spikes/go-container/internal/dbping"
)

// fakeClock advances by step on every read so each Ping measures exactly step.
type fakeClock struct {
	t    time.Time
	step time.Duration
}

func (c *fakeClock) now() time.Time { c.t = c.t.Add(c.step); return c.t }

type fakeSession struct {
	pings   int
	failAt  int
	closed  bool
	encrypt bool
}

func (s *fakeSession) Ping(context.Context) error {
	s.pings++
	if s.failAt > 0 && s.pings == s.failAt {
		return errors.New("boom")
	}
	return nil
}
func (s *fakeSession) Encrypted() bool             { return s.encrypt }
func (s *fakeSession) Close(context.Context) error { s.closed = true; return nil }

type fakeConnector struct {
	session *fakeSession
	timings dbping.ConnectTimings
	err     error
}

func (c fakeConnector) Connect(context.Context) (dbping.Session, dbping.ConnectTimings, error) {
	if c.err != nil {
		return nil, dbping.ConnectTimings{}, c.err
	}
	return c.session, c.timings, nil
}

func TestRun(t *testing.T) {
	timings := dbping.ConnectTimings{TCP: 2 * time.Millisecond, TLS: 3 * time.Millisecond, Total: 9 * time.Millisecond}
	session := &fakeSession{encrypt: true}
	clock := &fakeClock{step: time.Millisecond}

	got, err := dbping.Run(context.Background(), fakeConnector{session: session, timings: timings}, 50, clock.now)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if session.pings != 51 {
		t.Errorf("pings = %d, want 51 (one first query plus 50 warm)", session.pings)
	}
	if !session.closed {
		t.Error("session was not closed")
	}
	if got.Queries != 50 || !got.Encrypted || got.TCPMs != 2 || got.TLSMs != 3 || got.ConnectMs != 9 || got.FirstQueryMs != 1 {
		t.Errorf("Run() = %+v", got)
	}
	if got.Warm.Count != 50 || got.Warm.P50Ms != 1 || got.Warm.MaxMs != 1 {
		t.Errorf("warm = %+v", got.Warm)
	}
}

func TestRunErrors(t *testing.T) {
	connectErr := errors.New("dial refused")
	tests := []struct {
		name      string
		connector fakeConnector
		n         int
		wantErr   error
	}{
		{name: "zero queries", connector: fakeConnector{session: &fakeSession{}}, n: 0, wantErr: dbping.ErrInvalidCount},
		{name: "too many queries", connector: fakeConnector{session: &fakeSession{}}, n: dbping.MaxQueries + 1, wantErr: dbping.ErrInvalidCount},
		{name: "connect fails", connector: fakeConnector{err: connectErr}, n: 5, wantErr: connectErr},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clock := &fakeClock{step: time.Millisecond}
			if _, err := dbping.Run(context.Background(), tt.connector, tt.n, clock.now); !errors.Is(err, tt.wantErr) {
				t.Fatalf("Run() error = %v, want %v", err, tt.wantErr)
			}
		})
	}
}

func TestRunClosesSessionWhenAQueryFails(t *testing.T) {
	session := &fakeSession{failAt: 3}
	clock := &fakeClock{step: time.Millisecond}
	_, err := dbping.Run(context.Background(), fakeConnector{session: session}, 10, clock.now)
	if err == nil {
		t.Fatal("Run() error = nil, want query failure")
	}
	if !session.closed {
		t.Error("session was not closed after a failed query")
	}
}

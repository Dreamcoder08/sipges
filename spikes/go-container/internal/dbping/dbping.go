// Package dbping measures connection setup and query round trips to a database.
package dbping

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/dreamcoder08/sipges/spikes/go-container/internal/latency"
)

// ConnectTimings splits the cost of opening one connection.
type ConnectTimings struct {
	TCP   time.Duration // DNS + TCP handshake.
	TLS   time.Duration // TLS negotiation, zero when the connection is not encrypted.
	Total time.Duration // Everything up to a ready session, startup and auth included.
}

// Session is one open database connection.
type Session interface {
	// Ping runs one trivial query round trip.
	Ping(ctx context.Context) error
	// Encrypted reports whether the session runs over TLS.
	Encrypted() bool
	Close(ctx context.Context) error
}

// Connector opens sessions to a named target.
type Connector interface {
	Connect(ctx context.Context) (Session, ConnectTimings, error)
}

// Result is what one measurement run reports.
type Result struct {
	Queries      int             `json:"queries"`
	Encrypted    bool            `json:"encrypted"`
	TCPMs        float64         `json:"tcpConnectMs"`
	TLSMs        float64         `json:"tlsHandshakeMs"`
	ConnectMs    float64         `json:"connectTotalMs"`
	FirstQueryMs float64         `json:"firstQueryMs"`
	Warm         latency.Summary `json:"warmQueries"`
}

// ErrInvalidCount is returned when the requested query count is out of range.
var ErrInvalidCount = errors.New("query count out of range")

// MaxQueries bounds one run so a request cannot hold a connection for long.
const MaxQueries = 1000

// Run opens one connection, runs one first query and then n warm queries.
// The first query is reported apart because it may include statement preparation.
func Run(ctx context.Context, connector Connector, n int, now func() time.Time) (result Result, err error) {
	if n < 1 || n > MaxQueries {
		return Result{}, fmt.Errorf("%w: %d (want 1..%d)", ErrInvalidCount, n, MaxQueries)
	}
	session, timings, err := connector.Connect(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("connect: %w", err)
	}
	defer func() {
		if closeErr := session.Close(context.WithoutCancel(ctx)); closeErr != nil && err == nil {
			err = fmt.Errorf("close: %w", closeErr)
		}
	}()

	first, err := timePing(ctx, session, now)
	if err != nil {
		return Result{}, fmt.Errorf("first query: %w", err)
	}
	warm := make([]time.Duration, 0, n)
	for i := range n {
		d, err := timePing(ctx, session, now)
		if err != nil {
			return Result{}, fmt.Errorf("warm query %d: %w", i+1, err)
		}
		warm = append(warm, d)
	}
	return Result{
		Queries:      n,
		Encrypted:    session.Encrypted(),
		TCPMs:        toMs(timings.TCP),
		TLSMs:        toMs(timings.TLS),
		ConnectMs:    toMs(timings.Total),
		FirstQueryMs: toMs(first),
		Warm:         latency.Summarize(warm),
	}, nil
}

func timePing(ctx context.Context, session Session, now func() time.Time) (time.Duration, error) {
	start := now()
	if err := session.Ping(ctx); err != nil {
		return 0, err
	}
	return now().Sub(start), nil
}

func toMs(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }

package engines

import (
	"bytes"
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"sync"
)

// Caller runs one engine request; *wasmengine.Engine satisfies it.
type Caller interface {
	Call(ctx context.Context, request []byte) (json.RawMessage, error)
}

// Memo limits: the answers it keeps, in number and bytes, and the largest it keeps at all.
const (
	memoEntries  = 64
	memoBytes    = 16 << 20
	memoMaxValue = 4 << 20
)

// ErrEnginePanicked is what callers waiting on a request get when the engine panicked on it.
var ErrEnginePanicked = errors.New("engines: the engine panicked on this request")

// Memo answers a request it answered before with the same bytes, without running the engine.
//
// It is sound only for an engine whose answer is a function of the request bytes alone, as the
// indicators engine is: it imports no clock (TestIndicatorsEngineIsPure), wazero gives every
// instance the same deterministic random_get source and an empty environment, and nothing
// outside the request reaches it. The IRSA of a project is the same request on every screen
// until a record changes, and computing it was most of the Go API's CPU (docs/benchmarks/
// go-cpu-profile.md). Only successful answers are kept; requests are keyed by their SHA-256.
//
// Concurrent callers of one request wait for the first: they share its answer or its engine
// error. When the first caller's own context ends (its client left), one waiter computes
// instead and the rest wait for that one.
type Memo struct {
	engine Caller

	mu       sync.Mutex
	entries  map[[sha256.Size]byte]*list.Element
	order    *list.List // most recently used first; values are *memoEntry
	bytes    int
	inFlight map[[sha256.Size]byte]*memoCall
}

type memoEntry struct {
	key   [sha256.Size]byte
	value json.RawMessage
}

// memoCall is a request being computed; others with the same key wait for it.
type memoCall struct {
	done    chan struct{}
	value   json.RawMessage
	err     error
	waiters int // callers waiting for it; m.mu guards it
	// callerGone is a failure of the computing caller's context, not of the request.
	callerGone bool
}

// NewMemo wraps engine, which must be pure (see Memo).
func NewMemo(engine Caller) *Memo {
	return &Memo{
		engine:   engine,
		entries:  map[[sha256.Size]byte]*list.Element{},
		order:    list.New(),
		inFlight: map[[sha256.Size]byte]*memoCall{},
	}
}

// Call is engine.Call. Each caller gets its own copy of the answer.
func (m *Memo) Call(ctx context.Context, request []byte) (json.RawMessage, error) {
	key := sha256.Sum256(request)
	m.mu.Lock()
	if e, ok := m.entries[key]; ok {
		m.order.MoveToFront(e)
		value := bytes.Clone(e.Value.(*memoEntry).value)
		m.mu.Unlock()
		return value, nil
	}
	if c, ok := m.inFlight[key]; ok {
		c.waiters++
		m.mu.Unlock()
		select {
		case <-c.done:
		case <-ctx.Done():
			return nil, context.Cause(ctx)
		}
		switch {
		case c.err == nil:
			return bytes.Clone(c.value), nil
		case c.callerGone:
			// Only the first caller's context ended (its client left): ask again, so one
			// waiter computes and the others wait for it.
			return m.Call(ctx, request)
		}
		return nil, c.err // the engine's own failure, or ErrEnginePanicked
	}
	c := &memoCall{done: make(chan struct{}), err: ErrEnginePanicked}
	m.inFlight[key] = c
	m.mu.Unlock()
	// Deferred, so a panicking engine still frees the key and wakes the waiters, with
	// ErrEnginePanicked, while the panic goes on to this caller.
	defer func() {
		m.mu.Lock()
		delete(m.inFlight, key)
		if c.err == nil {
			m.store(key, c.value)
		}
		m.mu.Unlock()
		close(c.done)
	}()

	value, err := m.engine.Call(ctx, request)
	c.value, c.err, c.callerGone = value, err, err != nil && ctx.Err() != nil
	if err != nil {
		return nil, err
	}
	return bytes.Clone(value), nil
}

// store keeps value under key, dropping the least recently used answers past the limits.
// m.mu is held.
func (m *Memo) store(key [sha256.Size]byte, value json.RawMessage) {
	if len(value) > memoMaxValue {
		return
	}
	m.entries[key] = m.order.PushFront(&memoEntry{key: key, value: value})
	m.bytes += len(value)
	for m.order.Len() > memoEntries || m.bytes > memoBytes {
		oldest := m.order.Back()
		e := m.order.Remove(oldest).(*memoEntry)
		delete(m.entries, e.key)
		m.bytes -= len(e.value)
	}
}

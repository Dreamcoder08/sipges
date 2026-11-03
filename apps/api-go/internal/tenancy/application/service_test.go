package application_test

import (
	"context"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

type countingStore struct {
	mu     sync.Mutex
	calls  map[string]int
	grants map[string][]domain.Scope
	before func(username string) // runs inside ListGrants, before it returns
}

func (s *countingStore) ListGrants(_ context.Context, username string) ([]domain.Scope, error) {
	s.mu.Lock()
	s.calls[username]++
	g := s.grants[username]
	s.mu.Unlock()
	if s.before != nil {
		s.before(username)
	}
	return g, nil
}

func (s *countingStore) count(u string) int { s.mu.Lock(); defer s.mu.Unlock(); return s.calls[u] }

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

var (
	a = domain.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-A"}
	b = domain.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-B"}
)

func TestResolve(t *testing.T) {
	t.Parallel()
	store := &countingStore{calls: map[string]int{}, grants: map[string][]domain.Scope{"one": {a}, "two": {a, b}}}
	svc := application.NewService(store, (&clock{time.Unix(0, 0)}).now)
	ctx := context.Background()
	got, _ := svc.Resolve(ctx, "one", "", "")
	if got.Scope == nil || *got.Scope != a {
		t.Fatalf("one grant: %+v", got)
	}
	got, _ = svc.Resolve(ctx, "two", "", "")
	if got.Scope != nil || !reflect.DeepEqual(got.Projects, []string{"SIPGES/PRJ-A", "SIPGES/PRJ-B"}) {
		t.Fatalf("two grants: %+v", got)
	}
	got, _ = svc.Resolve(ctx, "none", "", "")
	if got.Scope != nil || got.Projects == nil || len(got.Projects) != 0 {
		t.Fatalf("no grants must list [] (JSON), got %#v", got.Projects)
	}
}

func TestGrantCacheTTLAndForget(t *testing.T) {
	t.Parallel()
	store := &countingStore{calls: map[string]int{}, grants: map[string][]domain.Scope{"u": {a}}}
	c := &clock{time.Unix(1000, 0)}
	svc := application.NewService(store, c.now)
	ctx := context.Background()
	for range 3 {
		_, _ = svc.Resolve(ctx, "u", "", "")
	}
	if n := store.count("u"); n != 1 {
		t.Fatalf("cached: %d loads", n)
	}
	c.t = c.t.Add(application.GrantCacheTTL - time.Millisecond)
	_, _ = svc.Resolve(ctx, "u", "", "")
	if n := store.count("u"); n != 1 {
		t.Fatalf("within TTL: %d loads", n)
	}
	c.t = c.t.Add(time.Millisecond)
	_, _ = svc.Resolve(ctx, "u", "", "")
	if n := store.count("u"); n != 2 {
		t.Fatalf("at TTL: %d loads", n)
	}
	svc.Forget("u")
	_, _ = svc.Resolve(ctx, "u", "", "")
	if n := store.count("u"); n != 3 {
		t.Fatalf("after Forget: %d loads", n)
	}
}

func TestALookupInFlightDuringForgetIsNotCached(t *testing.T) {
	t.Parallel()
	store := &countingStore{calls: map[string]int{}, grants: map[string][]domain.Scope{"u": {a}}}
	svc := application.NewService(store, (&clock{time.Unix(0, 0)}).now)
	store.before = func(string) { svc.Forget("other") }
	_, _ = svc.Resolve(context.Background(), "u", "", "")
	store.before = nil
	_, _ = svc.Resolve(context.Background(), "u", "", "")
	if n := store.count("u"); n != 2 {
		t.Fatalf("stale lookup was cached: %d loads", n)
	}
}

func TestGrantCacheEvictsTheOldestOf1000Users(t *testing.T) {
	t.Parallel()
	store := &countingStore{calls: map[string]int{}, grants: map[string][]domain.Scope{}}
	svc := application.NewService(store, (&clock{time.Unix(0, 0)}).now)
	ctx := context.Background()
	for i := range 1001 {
		_, _ = svc.Resolve(ctx, fmt.Sprintf("u%d", i), "", "")
	}
	_, _ = svc.Resolve(ctx, "u1", "", "")
	_, _ = svc.Resolve(ctx, "u0", "", "")
	if store.count("u1") != 1 || store.count("u0") != 2 {
		t.Fatalf("u0 loads %d (want 2, evicted), u1 loads %d (want 1)", store.count("u0"), store.count("u1"))
	}
}

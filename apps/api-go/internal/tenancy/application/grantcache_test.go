package application_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// Ported from apps/api/test/tenancy/grant-cache.test.ts.

type fakeStore struct {
	mu      sync.Mutex
	grants  map[string][]domain.Grant
	lookups int
	hold    chan struct{} // when set, the next lookup reads, then waits for it to close
	held    chan struct{}
	fail    error
}

func (f *fakeStore) load(_ context.Context, username string) ([]domain.Grant, error) {
	f.mu.Lock()
	f.lookups++
	read := append([]domain.Grant(nil), f.grants[username]...)
	hold, held, fail := f.hold, f.held, f.fail
	f.hold, f.fail = nil, nil
	f.mu.Unlock()
	if hold != nil {
		close(held)
		<-hold
	}
	return read, fail
}

func (f *fakeStore) set(username string, grants ...domain.Grant) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.grants[username] = grants
}

func (f *fakeStore) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lookups
}

type clock struct {
	mu sync.Mutex
	at time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.at }
func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = c.at.Add(d)
}

var norte = domain.Grant{Scope: domain.Scope{CompanyID: "ACME", ProjectID: "NORTE"}, Label: "Norte"}
var sur = domain.Grant{Scope: domain.Scope{CompanyID: "ACME", ProjectID: "SUR"}, Label: "Sur"}

func setup() (*fakeStore, *clock, *application.GrantCache) {
	store := &fakeStore{grants: map[string][]domain.Grant{"analista": {norte, sur}}}
	clk := &clock{at: time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)}
	return store, clk, application.NewGrantCache(store.load, clk.now)
}

func mustGet(t *testing.T, c *application.GrantCache, user string) []domain.Grant {
	t.Helper()
	g, err := c.Get(context.Background(), user)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func TestReusesGrantsForLessThan30Seconds(t *testing.T) {
	store, clk, cache := setup()
	mustGet(t, cache, "analista")
	clk.advance(application.GrantCacheTTL - time.Millisecond)
	mustGet(t, cache, "analista")
	if store.count() != 1 {
		t.Fatalf("lookups = %d, want 1", store.count())
	}
	clk.advance(time.Millisecond) // exactly 30 s old
	mustGet(t, cache, "analista")
	if store.count() != 2 {
		t.Fatalf("lookups = %d, want 2", store.count())
	}
}

func TestForgetStopsResolvingARevokedProjectAtOnce(t *testing.T) {
	store, _, cache := setup()
	mustGet(t, cache, "analista")
	store.set("analista", norte)
	cache.Forget("analista")
	if got := mustGet(t, cache, "analista"); len(got) != 1 || got[0] != norte {
		t.Fatalf("got %v", got)
	}
}

func TestDoesNotCacheGrantsReadBeforeAForgetThatFinishedFirst(t *testing.T) {
	store, _, cache := setup()
	store.hold, store.held = make(chan struct{}), make(chan struct{})
	hold, held := store.hold, store.held
	done := make(chan []domain.Grant)
	go func() { g, _ := cache.Get(context.Background(), "analista"); done <- g }()
	<-held // the slow lookup has read both grants
	store.set("analista", norte)
	cache.Forget("analista")
	close(hold)
	if slow := <-done; len(slow) != 2 {
		t.Fatalf("slow lookup returned %v", slow)
	}
	if got := mustGet(t, cache, "analista"); len(got) != 1 {
		t.Fatalf("stale grants were cached: %v", got)
	}
}

func TestErrorsAreNotCached(t *testing.T) {
	store, _, cache := setup()
	store.fail = errors.New("database down")
	if _, err := cache.Get(context.Background(), "analista"); err == nil {
		t.Fatal("want the load error")
	}
	if got := mustGet(t, cache, "analista"); len(got) != 2 {
		t.Fatalf("got %v", got)
	}
	if store.count() != 2 {
		t.Fatalf("lookups = %d, want 2", store.count())
	}
}

func TestKeepsAtMost1000UsersDroppingTheOldest(t *testing.T) {
	store, _, cache := setup()
	for i := 0; i <= 1000; i++ {
		mustGet(t, cache, fmt.Sprintf("u%d", i))
	}
	if store.count() != 1001 {
		t.Fatalf("lookups = %d", store.count())
	}
	mustGet(t, cache, "u1000")
	mustGet(t, cache, "u1")
	if store.count() != 1001 {
		t.Fatalf("lookups = %d, want 1001", store.count())
	}
	mustGet(t, cache, "u0")
	if store.count() != 1002 {
		t.Fatalf("lookups = %d, want 1002", store.count())
	}
}

func TestCallersCannotChangeTheCachedGrants(t *testing.T) {
	_, _, cache := setup()
	first := mustGet(t, cache, "analista")
	first[0].ProjectID = "EVIL"
	if got := mustGet(t, cache, "analista"); got[0] != norte {
		t.Fatalf("cached grants changed: %v", got)
	}
}

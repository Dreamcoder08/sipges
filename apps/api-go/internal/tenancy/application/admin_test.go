package application_test

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// Ported from apps/api/test/tenancy/grant-cache.test.ts (the service half): a grant change made
// through the service reaches the request path's cache at once, failed writes included.

var admin = application.Actor{Username: "admin", Role: "admin"}

// adminStore is the in-memory TenancyStore of grant-cache.test.ts over fakeStore's grants.
type adminStore struct {
	*fakeStore
	mu         sync.Mutex
	failNext   error // returned by the next write, after it took effect
	writeTimes []time.Time
}

func (s *adminStore) fail() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	err := s.failNext
	s.failNext = nil
	return err
}

func (s *adminStore) at(t time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.writeTimes = append(s.writeTimes, t)
}

func (s *adminStore) add(username string, g domain.Grant) {
	s.fakeStore.mu.Lock()
	defer s.fakeStore.mu.Unlock()
	s.grants[username] = append(slices.Clone(s.grants[username]), g)
}

func (s *adminStore) CreateTenantWithGrant(_ context.Context, t domain.NewTenant, at time.Time) (bool, error) {
	s.at(at)
	s.add(t.Username, domain.Grant{Scope: t.Scope, Label: t.Label})
	return true, s.fail()
}

func (s *adminStore) TenantExists(context.Context, domain.Scope) (bool, error) { return true, nil }

func (s *adminStore) Grant(_ context.Context, username string, sc domain.Scope, at time.Time) error {
	s.at(at)
	s.add(username, domain.Grant{Scope: sc, Label: "Nuevo"})
	return s.fail()
}

func (s *adminStore) Revoke(_ context.Context, username string, sc domain.Scope) (bool, error) {
	s.fakeStore.mu.Lock()
	s.grants[username] = slices.DeleteFunc(slices.Clone(s.grants[username]), func(g domain.Grant) bool { return g.Scope == sc })
	s.fakeStore.mu.Unlock()
	return true, s.fail()
}

func (s *adminStore) ListGrants(ctx context.Context, username string) ([]domain.Grant, error) {
	return s.load(ctx, username)
}

type adminFixture struct {
	store *adminStore
	cache *application.GrantCache
	svc   application.Admin
	clk   *clock
}

func adminSetup(t *testing.T) adminFixture {
	t.Helper()
	fake, clk, cache := setup()
	store := &adminStore{fakeStore: fake}
	svc := application.Admin{
		Store:  store,
		Users:  func(context.Context, string) (bool, error) { return true, nil },
		Forget: application.ForgetEverywhere,
		Now:    clk.now,
	}
	return adminFixture{store: store, cache: cache, svc: svc, clk: clk}
}

func (f adminFixture) resolves(t *testing.T, scope string) bool {
	t.Helper()
	_, ok := domain.ResolveScope(scope, "", mustGet(t, f.cache, "analista"))
	return ok
}

var surScope = domain.Scope{CompanyID: "ACME", ProjectID: "SUR"}

func TestServiceStopsResolvingARevokedProjectAtOnce(t *testing.T) {
	f := adminSetup(t)
	if !f.resolves(t, "ACME/SUR") {
		t.Fatal("SUR should resolve before the revoke")
	}
	if code, err := f.svc.Revoke(context.Background(), admin, "analista", surScope); code != "" || err != nil {
		t.Fatalf("revoke = %q, %v", code, err)
	}
	if f.resolves(t, "ACME/SUR") {
		t.Fatal("a revoked project still resolves")
	}
}

func TestServiceResolvesANewlyGrantedOrCreatedProjectAtOnce(t *testing.T) {
	f := adminSetup(t)
	f.resolves(t, "ACME/NORTE")
	if code, err := f.svc.Grant(context.Background(), admin, "analista", domain.Scope{CompanyID: "ACME", ProjectID: "ESTE"}); code != "" || err != nil {
		t.Fatalf("grant = %q, %v", code, err)
	}
	if !f.resolves(t, "ACME/ESTE") {
		t.Fatal("the new grant does not resolve")
	}
	scope, code, err := f.svc.CreateTenant(context.Background(), admin, domain.NewTenant{
		Scope: domain.Scope{CompanyID: "ACME", ProjectID: "OESTE"}, Label: "Oeste", Username: "analista",
	})
	if scope != "ACME/OESTE" || code != "" || err != nil {
		t.Fatalf("create = %q, %q, %v", scope, code, err)
	}
	if !f.resolves(t, "ACME/OESTE") {
		t.Fatal("the created project does not resolve")
	}
}

func TestServiceDoesNotCacheGrantsReadBeforeARevokeThatFinishedFirst(t *testing.T) {
	f := adminSetup(t)
	f.store.hold, f.store.held = make(chan struct{}), make(chan struct{})
	hold, held := f.store.hold, f.store.held
	done := make(chan struct{})
	go func() { _, _ = f.cache.Get(context.Background(), "analista"); close(done) }()
	<-held
	if _, err := f.svc.Revoke(context.Background(), admin, "analista", surScope); err != nil {
		t.Fatal(err)
	}
	close(hold)
	<-done
	if f.resolves(t, "ACME/SUR") {
		t.Fatal("grants read before the revoke were cached")
	}
}

func TestServiceForgetsEvenWhenTheStoreFailsAfterCommitting(t *testing.T) {
	writes := map[string]func(f adminFixture) error{
		"revoke": func(f adminFixture) error {
			_, err := f.svc.Revoke(context.Background(), admin, "analista", surScope)
			return err
		},
		"grant": func(f adminFixture) error {
			_, err := f.svc.Grant(context.Background(), admin, "analista", domain.Scope{CompanyID: "ACME", ProjectID: "ESTE"})
			return err
		},
		"create": func(f adminFixture) error {
			_, _, err := f.svc.CreateTenant(context.Background(), admin, domain.NewTenant{
				Scope: domain.Scope{CompanyID: "ACME", ProjectID: "ESTE"}, Label: "Este", Username: "analista",
			})
			return err
		},
	}
	for name, write := range writes {
		t.Run(name, func(t *testing.T) {
			f := adminSetup(t)
			f.resolves(t, "ACME/SUR")
			before := f.store.count()
			f.store.failNext = errors.New("connection lost after commit")
			if err := write(f); err == nil {
				t.Fatal("want the store error")
			}
			mustGet(t, f.cache, "analista")
			if f.store.count() != before+1 {
				t.Fatal("the cached copy outlived a failed write")
			}
		})
	}
}

// Refusals before the write leave the cache alone, as the TypeScript early returns do.
func TestServiceKeepsTheCacheOnRefusals(t *testing.T) {
	f := adminSetup(t)
	forgotten := []string{}
	f.svc.Forget = func(u string) { forgotten = append(forgotten, u) }
	ctx := context.Background()
	analyst := application.Actor{Username: "ana", Role: "analista"}
	if code, _ := f.svc.Grant(ctx, analyst, "analista", surScope); code != application.ErrForbidden {
		t.Fatalf("grant by an analyst = %q", code)
	}
	if code, _ := f.svc.Revoke(ctx, analyst, "analista", surScope); code != application.ErrForbidden {
		t.Fatalf("revoke by an analyst = %q", code)
	}
	if _, code, _ := f.svc.CreateTenant(ctx, admin, domain.NewTenant{Scope: domain.Scope{CompanyID: "A", ProjectID: "NORTE"}, Username: "analista"}); code != domain.ErrInvalidIDs {
		t.Fatalf("create with a short id = %q", code)
	}
	f.svc.Users = func(context.Context, string) (bool, error) { return false, nil }
	if code, _ := f.svc.Grant(ctx, admin, "nobody", surScope); code != application.ErrUserMissing {
		t.Fatalf("grant to nobody = %q", code)
	}
	if len(forgotten) != 0 {
		t.Fatalf("forgot %v on refusals", forgotten)
	}
}

func TestServiceReportsAnAbsentGrantAndStillForgets(t *testing.T) {
	f := adminSetup(t)
	forgotten := []string{}
	f.svc.Forget = func(u string) { forgotten = append(forgotten, u) }
	ctx := context.Background()
	if code, err := f.svc.Revoke(ctx, admin, "analista", surScope); code != "" || err != nil {
		t.Fatal(code, err)
	}
	store := &absentRevoke{f.store}
	f.svc.Store = store
	if code, err := f.svc.Revoke(ctx, admin, "analista", surScope); code != application.ErrGrantMissing || err != nil {
		t.Fatalf("second revoke = %q, %v", code, err)
	}
	if !slices.Equal(forgotten, []string{"analista", "analista"}) {
		t.Fatalf("forgot %v", forgotten)
	}
}

type absentRevoke struct{ *adminStore }

func (absentRevoke) Revoke(context.Context, string, domain.Scope) (bool, error) { return false, nil }

func TestServiceReadsGrantsFreshForTheProjectChoice(t *testing.T) {
	f := adminSetup(t)
	mustGet(t, f.cache, "analista")
	for range 2 {
		if ok, err := f.svc.IsGranted(context.Background(), "analista", "ACME/NORTE"); !ok || err != nil {
			t.Fatal(ok, err)
		}
	}
	if ok, _ := f.svc.IsGranted(context.Background(), "analista", "ACME/NORTE "); ok {
		t.Fatal("a scope with a trailing space matched")
	}
	if f.store.count() != 4 { // the cached request copy, then three fresh reads
		t.Fatalf("lookups = %d, want 4", f.store.count())
	}
}

// clock.now() is a JavaScript Date: writes store whole milliseconds.
func TestServiceWritesMillisecondTimes(t *testing.T) {
	f := adminSetup(t)
	f.clk.at = time.Date(2026, 1, 2, 3, 4, 5, 678_999_999, time.UTC)
	if _, err := f.svc.Grant(context.Background(), admin, "analista", surScope); err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 1, 2, 3, 4, 5, 678_000_000, time.UTC)
	if len(f.store.writeTimes) != 1 || !f.store.writeTimes[0].Equal(want) {
		t.Fatalf("times = %v, want %v", f.store.writeTimes, want)
	}
}

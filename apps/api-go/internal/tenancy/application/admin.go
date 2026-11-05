package application

import (
	"context"
	"slices"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// The errors of tenancy-service.ts createTenant, grant and revoke, as the routes map them.
const (
	ErrForbidden     = "forbidden"
	ErrUserMissing   = "user_missing"
	ErrTenantMissing = "tenant_missing"
	ErrGrantMissing  = "grant_missing"
	ErrExists        = "exists"
)

// Store is the part of TenancyStore (ports.ts) the administration uses.
type Store interface {
	// CreateTenantWithGrant creates the tenant and its first grant in one transaction; false
	// when the tenant exists.
	CreateTenantWithGrant(ctx context.Context, t domain.NewTenant, at time.Time) (bool, error)
	TenantExists(ctx context.Context, s domain.Scope) (bool, error)
	// Grant is idempotent.
	Grant(ctx context.Context, username string, s domain.Scope, at time.Time) error
	// Revoke deletes exactly one grant; false when it was already absent.
	Revoke(ctx context.Context, username string, s domain.Scope) (bool, error)
	ListGrants(ctx context.Context, username string) ([]domain.Grant, error)
}

// UserExists is UserDirectory.exists: whether the account row exists, active or not.
type UserExists func(ctx context.Context, username string) (bool, error)

// Actor is the session's user.
type Actor struct {
	Username string
	Role     string
}

// Admin is the administration half of tenancy-service.ts: projects, grants and the project
// choice. Checks run in the TypeScript order, each a statement of its own; only creation
// writes in a transaction.
type Admin struct {
	Store Store
	Users UserExists
	// Forget drops a user's cached grants (ForgetEverywhere); it runs after every grant change,
	// failed or not, as the TypeScript finally blocks do.
	Forget func(username string)
	// Now is the clock; nil means time.Now.
	Now func() time.Time
}

// now is clock.now() as a JavaScript Date holds it: whole milliseconds.
func (a Admin) now() time.Time {
	now := time.Now
	if a.Now != nil {
		now = a.Now
	}
	return now().Truncate(time.Millisecond)
}

// ListGranted is listGranted: read fresh, never from the request cache.
func (a Admin) ListGranted(ctx context.Context, username string) ([]domain.Grant, error) {
	return a.Store.ListGrants(ctx, username)
}

// IsGranted is isGranted: whether "company/project" is one of the user's grants, read fresh.
func (a Admin) IsGranted(ctx context.Context, username, scope string) (bool, error) {
	grants, err := a.Store.ListGrants(ctx, username)
	if err != nil {
		return false, err
	}
	return slices.ContainsFunc(grants, func(g domain.Grant) bool { return g.TenantID() == scope }), nil
}

// CreateTenant is createTenant. It returns the new scope, or an error code: ErrForbidden,
// domain.ErrInvalidIDs, domain.ErrReserved, ErrUserMissing, ErrExists.
func (a Admin) CreateTenant(ctx context.Context, actor Actor, in domain.NewTenant) (string, string, error) {
	if actor.Role != "admin" {
		return "", ErrForbidden, nil
	}
	valid, code := domain.ValidateNewTenant(in)
	if code != "" {
		return "", code, nil
	}
	if ok, err := a.Users(ctx, valid.Username); err != nil {
		return "", "", err
	} else if !ok {
		return "", ErrUserMissing, nil
	}
	// Forget even when the write fails after committing: a stale copy must not outlive it.
	defer a.Forget(valid.Username)
	created, err := a.Store.CreateTenantWithGrant(ctx, valid, a.now())
	if err != nil {
		return "", "", err
	}
	if !created {
		return "", ErrExists, nil
	}
	return valid.TenantID(), "", nil
}

// Grant is grant: idempotent. It returns "" or ErrForbidden, ErrUserMissing, ErrTenantMissing.
func (a Admin) Grant(ctx context.Context, actor Actor, username string, s domain.Scope) (string, error) {
	if code, err := a.references(ctx, actor, username, s); code != "" || err != nil {
		return code, err
	}
	defer a.Forget(username)
	return "", a.Store.Grant(ctx, username, s, a.now())
}

// Revoke is revoke. It returns "" or ErrForbidden, ErrUserMissing, ErrTenantMissing,
// ErrGrantMissing.
func (a Admin) Revoke(ctx context.Context, actor Actor, username string, s domain.Scope) (string, error) {
	if code, err := a.references(ctx, actor, username, s); code != "" || err != nil {
		return code, err
	}
	defer a.Forget(username)
	deleted, err := a.Store.Revoke(ctx, username, s)
	if err != nil || deleted {
		return "", err
	}
	return ErrGrantMissing, nil
}

// references runs the checks grant and revoke share, in order: admin, user, tenant.
func (a Admin) references(ctx context.Context, actor Actor, username string, s domain.Scope) (string, error) {
	if actor.Role != "admin" {
		return ErrForbidden, nil
	}
	if ok, err := a.Users(ctx, username); err != nil {
		return "", err
	} else if !ok {
		return ErrUserMissing, nil
	}
	if ok, err := a.Store.TenantExists(ctx, s); err != nil {
		return "", err
	} else if !ok {
		return ErrTenantMissing, nil
	}
	return "", nil
}

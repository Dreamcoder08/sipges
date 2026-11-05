// Package application holds the identity use cases: the Go port of
// apps/api/src/contexts/identity/application/identity-service.ts.
package application

import (
	"context"
	"sync"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
)

// SessionSeconds is SESSION_SECONDS: a session lives 8 hours.
const SessionSeconds = 8 * 3600

// dummyPassword is DUMMY_HASH_INPUT. Verifying it for unknown users keeps response timing uniform.
const dummyPassword = "timing-equalizer-password"

// StoredUser is StoredUser of ports.ts.
type StoredUser struct {
	Username         string
	FullName         string
	PasswordHash     string
	Role             domain.Role
	Active           bool
	TOTPSecretSealed *string
	TOTPEnabled      bool
	TOTPLastStep     *int64
	GoogleEmail      *string
}

// LoginAttempt is the input of Store.ReserveLoginAttempt.
type LoginAttempt struct {
	UserSubject string
	IPSubject   string
	WindowStart time.Time
	At          time.Time
}

// Store is the part of IdentityStore (ports.ts) the login uses.
type Store interface {
	// ReserveLoginAttempt counts recent failures for both subjects under per-subject locks and,
	// when the throttle allows it, records this attempt as a provisional failure.
	ReserveLoginAttempt(ctx context.Context, attempt LoginAttempt) (domain.ThrottleDecision, []int64, error)
	// ReleaseLoginAttempt removes a provisional failure after the attempt succeeded.
	ReleaseLoginAttempt(ctx context.Context, reservation []int64) error
	ClearFailures(ctx context.Context, subject string) error
	FindUser(ctx context.Context, username string) (*StoredUser, error)
	UpdatePasswordHash(ctx context.Context, username, passwordHash string) error
	// CreateSession is false when deactivation won the race.
	CreateSession(ctx context.Context, tokenHash, username string, expiresAt, at time.Time, viaGoogle bool) (bool, error)
	PurgeExpiredSessions(ctx context.Context, at time.Time) error
}

// PasswordHasher is PasswordHasher of ports.ts.
type PasswordHasher interface {
	Hash(password string) (string, error)
	Verify(password, stored string) bool
	NeedsRehash(stored string) bool
}

// SessionTokens is SessionTokens of ports.ts.
type SessionTokens interface {
	NewToken() (string, error)
	Hash(token string) string
}

// Deps is what the identity service needs.
type Deps struct {
	Store  Store
	Hasher PasswordHasher
	Tokens SessionTokens
	// Now is the clock; nil means time.Now.
	Now func() time.Time
}

// Service is createIdentityService.
type Service struct {
	deps  Deps
	dummy func() (string, error)
}

// NewService starts computing the dummy hash at once, so the first unknown-user login costs the
// same as later ones.
func NewService(deps Deps) *Service {
	s := &Service{deps: deps}
	s.dummy = sync.OnceValues(func() (string, error) { return deps.Hasher.Hash(dummyPassword) })
	go func() { _, _ = s.dummy() }()
	return s
}

// now is clock.now(): JavaScript dates carry milliseconds, so the same instant compares the
// same way in PostgreSQL.
func (s *Service) now() time.Time {
	if s.deps.Now != nil {
		return s.deps.Now().Truncate(time.Millisecond)
	}
	return time.Now().Truncate(time.Millisecond)
}

// LoginFailure is LoginError's kind; empty means the login succeeded.
type LoginFailure string

// The kinds of LoginError.
const (
	InvalidCredentials LoginFailure = "invalid_credentials" //nolint:gosec // an error kind, not a credential
	InvalidOTP         LoginFailure = "invalid_otp"
	Throttled          LoginFailure = "throttled"
)

// LoginInput is the input of Login.
type LoginInput struct {
	Username string
	Password string
	OTP      string
	IP       string
}

// LoginResult is Result<LoginSuccess, LoginError>.
type LoginResult struct {
	Failure           LoginFailure
	RetryAfterSeconds int
	Token             string
	Username          string
	FullName          string
	Role              domain.Role
}

func (s *Service) equalizeTiming(password string) error {
	dummy, err := s.dummy()
	if err != nil {
		return err
	}
	s.deps.Hasher.Verify(password, dummy)
	return nil
}

// Login is identity-service.ts login, step by step. The attempt is reserved before verifying,
// so it counts as a failure unless it succeeds, and every refusal after that is one of two
// generic answers. The caller detaches ctx from the client: as in TypeScript, a login that
// started runs to its end.
func (s *Service) Login(ctx context.Context, input LoginInput) (LoginResult, error) {
	now := s.now()
	username := domain.NormalizeUsername(input.Username)
	userKey, lookupable := domain.LoginUsername(username)
	decision, reservation, err := s.deps.Store.ReserveLoginAttempt(ctx, LoginAttempt{
		UserSubject: userKey,
		IPSubject:   domain.IPSubject(input.IP),
		WindowStart: now.Add(-domain.ThrottleWindow * time.Second),
		At:          now,
	})
	if err != nil {
		return LoginResult{}, err
	}
	if !decision.Allowed {
		return LoginResult{Failure: Throttled, RetryAfterSeconds: decision.RetryAfterSeconds}, nil
	}

	var user *StoredUser
	if lookupable {
		if user, err = s.deps.Store.FindUser(ctx, username); err != nil {
			return LoginResult{}, err
		}
	}
	if user == nil {
		if err := s.equalizeTiming(input.Password); err != nil {
			return LoginResult{}, err
		}
		return LoginResult{Failure: InvalidCredentials}, nil
	}
	if !s.deps.Hasher.Verify(input.Password, user.PasswordHash) || !user.Active {
		return LoginResult{Failure: InvalidCredentials}, nil
	}

	if user.TOTPEnabled {
		// The second factor is not ported yet: fail closed, never skip it.
		return LoginResult{Failure: InvalidOTP}, nil
	}

	if s.deps.Hasher.NeedsRehash(user.PasswordHash) {
		hash, err := s.deps.Hasher.Hash(input.Password)
		if err != nil {
			return LoginResult{}, err
		}
		if err := s.deps.Store.UpdatePasswordHash(ctx, username, hash); err != nil {
			return LoginResult{}, err
		}
	}
	token, err := s.deps.Tokens.NewToken()
	if err != nil {
		return LoginResult{}, err
	}
	expires := now.Add(SessionSeconds * time.Second)
	created, err := s.deps.Store.CreateSession(ctx, s.deps.Tokens.Hash(token), username, expires, now, false)
	if err != nil {
		return LoginResult{}, err
	}
	if !created {
		return LoginResult{Failure: InvalidCredentials}, nil
	}
	if err := s.deps.Store.ReleaseLoginAttempt(ctx, reservation); err != nil {
		return LoginResult{}, err
	}
	if err := s.deps.Store.ClearFailures(ctx, userKey); err != nil {
		return LoginResult{}, err
	}
	if err := s.deps.Store.PurgeExpiredSessions(ctx, now); err != nil {
		return LoginResult{}, err
	}
	return LoginResult{Token: token, Username: username, FullName: user.FullName, Role: user.Role}, nil
}

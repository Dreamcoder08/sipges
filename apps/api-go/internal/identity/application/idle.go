package application

import (
	"context"
	"time"
)

// idleWriteSlackSeconds bounds the sliding-expiry writes: a session is only extended once less
// than IdleSeconds minus this slack remains, so a busy session writes at most once per 5 minutes.
const idleWriteSlackSeconds = 5 * 60

// SessionRenewal is the sliding expiry of one authenticated request made At (world-class-local
// T8f). The session moves to min(created_at + AbsoluteSeconds, IdleUntil), only while it still
// expires before RenewBefore, and only when that instant is later than its current expiry: it
// never passes the absolute cap and never shortens a session.
type SessionRenewal struct {
	At              time.Time
	IdleUntil       time.Time
	RenewBefore     time.Time
	AbsoluteSeconds int
}

// NewSessionRenewal is the renewal of a request made at `at`. JavaScript dates carry
// milliseconds, so the instants do too, as Authenticate compares them.
func NewSessionRenewal(at time.Time) SessionRenewal {
	at = at.Truncate(time.Millisecond)
	return SessionRenewal{
		At:              at,
		IdleUntil:       at.Add(IdleSeconds * time.Second),
		RenewBefore:     at.Add((IdleSeconds - idleWriteSlackSeconds) * time.Second),
		AbsoluteSeconds: SessionSeconds,
	}
}

// RemainingSeconds is the whole seconds from at until expires, never negative: what the session
// middleware tells the web in X-SIPGES-Session-Remaining.
func RemainingSeconds(expires, at time.Time) int {
	if !expires.After(at) {
		return 0
	}
	return int(expires.Sub(at) / time.Second)
}

// SessionExtender stores a renewal.
type SessionExtender interface {
	// ExtendSession applies r to the unexpired session of tokenHash in one conditional write
	// and returns the new expiry; false when the rule left it unchanged.
	ExtendSession(ctx context.Context, tokenHash string, r SessionRenewal) (time.Time, bool, error)
}

// SessionActivity follows the idle expiry of sessions that already authenticated.
type SessionActivity struct {
	Sessions SessionExtender
	Tokens   SessionTokens
	// Now is the clock; nil means time.Now.
	Now func() time.Time
}

// Record is one authenticated request on the session of token, which expired at `expires` when
// it authenticated. User activity slides the expiry by the idle rule; a background request does
// not. It returns the whole seconds the session has left afterwards, the stored expiry and the
// 8-hour cap included. When the extension fails it returns the unextended remainder and the error.
func (a SessionActivity) Record(ctx context.Context, token string, expires time.Time, userActivity bool) (int, error) {
	now := time.Now
	if a.Now != nil {
		now = a.Now
	}
	renewal := NewSessionRenewal(now())
	if !userActivity {
		return RemainingSeconds(expires, renewal.At), nil
	}
	extended, ok, err := a.Sessions.ExtendSession(ctx, a.Tokens.Hash(token), renewal)
	if err != nil {
		return RemainingSeconds(expires, renewal.At), err
	}
	if ok {
		expires = extended
	}
	return RemainingSeconds(expires, renewal.At), nil
}

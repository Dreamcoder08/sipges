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

// SessionExtender stores a renewal.
type SessionExtender interface {
	// ExtendSession applies r to the unexpired session of tokenHash in one conditional write;
	// false when the rule left it unchanged.
	ExtendSession(ctx context.Context, tokenHash string, r SessionRenewal) (bool, error)
}

// SessionActivity records user activity on a session that already authenticated.
type SessionActivity struct {
	Sessions SessionExtender
	Tokens   SessionTokens
	// Now is the clock; nil means time.Now.
	Now func() time.Time
}

// Touch extends the session of token by the sliding idle rule.
func (a SessionActivity) Touch(ctx context.Context, token string) error {
	now := time.Now
	if a.Now != nil {
		now = a.Now
	}
	_, err := a.Sessions.ExtendSession(ctx, a.Tokens.Hash(token), NewSessionRenewal(now()))
	return err
}

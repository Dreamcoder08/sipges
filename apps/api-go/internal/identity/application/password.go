package application

import (
	"context"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
)

// PasswordChangeFailure is why a password change was refused; empty means it succeeded.
type PasswordChangeFailure string

// The kinds of refusal of ChangePassword.
const (
	// PasswordWrongCurrent answers like a failed sign-in: the change cannot be used to tell a
	// right password from a wrong one any faster than the login.
	PasswordWrongCurrent PasswordChangeFailure = "wrong_current"
	PasswordThrottled    PasswordChangeFailure = "throttled"
	// PasswordRejected is a new password the policy refuses; Detail says which rule.
	PasswordRejected PasswordChangeFailure = "rejected"
	// PasswordSessionEnded is a request whose session ended before the change was written:
	// nothing changed, and the caller is signed out.
	PasswordSessionEnded PasswordChangeFailure = "session_ended"
)

// PasswordChange is the input of ChangePassword.
type PasswordChange struct {
	Current string
	New     string
	IP      string
}

// PasswordChangeResult is the outcome of ChangePassword.
type PasswordChangeResult struct {
	Failure           PasswordChangeFailure
	Detail            string
	RetryAfterSeconds int
}

// ChangePassword replaces the actor's own password. Every attempt is reserved against the login
// throttle before the current password is checked, so it counts as a failed sign-in unless that
// password is right. On success every other session of the actor ends and currentToken's session
// stays open, audited in tenantID. The caller detaches ctx from the client, as for Login.
func (s *Service) ChangePassword(ctx context.Context, actor *domain.Principal, currentToken string, input PasswordChange, tenantID string) (PasswordChangeResult, error) {
	now := s.now()
	username := actor.Username
	decision, reservation, err := s.deps.Store.ReserveLoginAttempt(ctx, LoginAttempt{
		UserSubject: domain.UserSubject(username),
		IPSubject:   domain.IPSubject(input.IP),
		WindowStart: now.Add(-domain.ThrottleWindow * time.Second),
		At:          now,
	})
	if err != nil {
		return PasswordChangeResult{}, err
	}
	if !decision.Allowed {
		return PasswordChangeResult{Failure: PasswordThrottled, RetryAfterSeconds: decision.RetryAfterSeconds}, nil
	}
	user, err := s.deps.Store.FindUser(ctx, username)
	if err != nil {
		return PasswordChangeResult{}, err
	}
	if user == nil || !user.Active || !s.deps.Hasher.Verify(input.Current, user.PasswordHash) {
		return PasswordChangeResult{Failure: PasswordWrongCurrent}, nil
	}
	if err := s.deps.Store.ReleaseLoginAttempt(ctx, reservation); err != nil {
		return PasswordChangeResult{}, err
	}
	if detail := domain.CheckNewPassword(username, input.Current, input.New); detail != "" {
		return PasswordChangeResult{Failure: PasswordRejected, Detail: detail}, nil
	}
	hash, err := s.deps.Hasher.Hash(input.New)
	if err != nil {
		return PasswordChangeResult{}, err
	}
	replaced, err := s.deps.Sessions.ReplacePassword(ctx, username, hash, s.deps.Tokens.Hash(currentToken), now, tenantID,
		func(count int) SessionAudit {
			return SessionAudit{
				Action:   "PASSWORD_CHANGE",
				RecordID: username,
				Detail:   "Contraseña cambiada por " + username + "; " + endedElsewhere(count),
				At:       now,
			}
		})
	if err != nil {
		return PasswordChangeResult{}, err
	}
	switch replaced {
	case PasswordUserInactive: // deactivated between the check and the write
		return PasswordChangeResult{Failure: PasswordWrongCurrent}, nil
	case PasswordSessionGone: // another change or a revoke ended this session first
		return PasswordChangeResult{Failure: PasswordSessionEnded}, nil
	}
	return PasswordChangeResult{}, nil
}

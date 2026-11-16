package application

import (
	"context"
	"regexp"
	"strconv"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
)

// StoredSession is StoredSession of ports.ts: the hash never leaves the application layer.
type StoredSession struct {
	TokenHash string
	CreatedAt time.Time
	ExpiresAt time.Time
	ViaGoogle bool
}

// SessionView is SessionView of identity-service.ts: one of the caller's own sessions as Cuenta
// shows it, with no token and no hash.
type SessionView struct {
	ID        string
	CreatedAt time.Time
	ExpiresAt time.Time
	ViaGoogle bool
	Current   bool
}

// SessionAudit is the audit row a session write appends to the active project's trail.
type SessionAudit struct {
	Action   string
	RecordID string
	Detail   string
	At       time.Time
}

// SessionStore is the part of IdentityStore Cuenta uses.
type SessionStore interface {
	// ListSessions is the user's unexpired sessions, newest first (ties by hash).
	ListSessions(ctx context.Context, username string, at time.Time) ([]StoredSession, error)
	// EndSession deletes one session only if it belongs to username and appends the audit row
	// to tenantID's trail, in one transaction. False when nothing was deleted (no audit row).
	EndSession(ctx context.Context, username, tokenHash, tenantID string, audit SessionAudit) (bool, error)
	// EndOtherSessions deletes every session of username still active at `at` except
	// keepTokenHash, the ones ListSessions shows, and appends the audit row for the count,
	// atomically. Expired rows are left to the purge. No audit row when the count is 0.
	EndOtherSessions(ctx context.Context, username, keepTokenHash string, at time.Time, tenantID string, audit func(count int) SessionAudit) (int, error)
}

// sessionID is the shape of SessionTokens.PublicID; anything else cannot name a session.
var sessionID = regexp.MustCompile(`^[0-9a-f]{32}$`)

// ListSessions is listSessions: the caller's own unexpired sessions with the requesting one
// marked.
func (s *Service) ListSessions(ctx context.Context, username, currentToken string) ([]SessionView, error) {
	current := s.deps.Tokens.Hash(currentToken)
	stored, err := s.deps.Sessions.ListSessions(ctx, username, s.now())
	if err != nil {
		return nil, err
	}
	out := make([]SessionView, len(stored))
	for i, row := range stored {
		out[i] = SessionView{
			ID:        s.deps.Tokens.PublicID(row.TokenHash),
			CreatedAt: row.CreatedAt,
			ExpiresAt: row.ExpiresAt,
			ViaGoogle: row.ViaGoogle,
			Current:   row.TokenHash == current,
		}
	}
	return out, nil
}

// EndSession is endSession: ends one of the caller's own sessions, audited in the active
// project. Another user's id is indistinguishable from an unknown one.
func (s *Service) EndSession(ctx context.Context, actor *domain.Principal, currentToken, id, tenantID string) (found, current bool, err error) {
	if !sessionID.MatchString(id) {
		return false, false, nil
	}
	at := s.now()
	stored, err := s.deps.Sessions.ListSessions(ctx, actor.Username, at)
	if err != nil {
		return false, false, err
	}
	for _, row := range stored {
		if s.deps.Tokens.PublicID(row.TokenHash) != id {
			continue
		}
		current = row.TokenHash == s.deps.Tokens.Hash(currentToken)
		detail := "Sesión " + id
		if current {
			detail += " (este dispositivo)"
		}
		ended, err := s.deps.Sessions.EndSession(ctx, actor.Username, row.TokenHash, tenantID, SessionAudit{
			Action: "SESSION_END", RecordID: actor.Username, Detail: detail + " cerrada por " + actor.Username, At: at,
		})
		if err != nil || !ended {
			return false, false, err
		}
		return true, current, nil
	}
	return false, false, nil
}

// EndOtherSessions is endOtherSessions («cerrar sesión en todos los demás dispositivos»): keeps
// only the requesting session and returns how many active ones ended, as the list shows them.
// Ending none writes no audit row, so any role repeating it cannot fill the trail.
func (s *Service) EndOtherSessions(ctx context.Context, actor *domain.Principal, currentToken, tenantID string) (int, error) {
	at := s.now()
	return s.deps.Sessions.EndOtherSessions(ctx, actor.Username, s.deps.Tokens.Hash(currentToken), at, tenantID,
		func(count int) SessionAudit {
			noun := "sesiones cerradas"
			if count == 1 {
				noun = "sesión cerrada"
			}
			return SessionAudit{
				Action:   "SESSIONS_END_OTHERS",
				RecordID: actor.Username,
				Detail:   strconv.Itoa(count) + " " + noun + " en otros dispositivos por " + actor.Username,
				At:       at,
			}
		})
}

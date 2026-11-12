package application_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
)

// Ported from apps/api/test/identity/sessions.test.ts at the service boundary; the HTTP answers
// of both APIs are compared by apps/parity/src/contexts/sessions.ts.

type session struct {
	username string
	application.StoredSession
}

// memorySessions is the session part of the store, in memory, with the audit rows it appended.
type memorySessions struct {
	rows  []session
	audit []application.SessionAudit
}

func (m *memorySessions) ListSessions(_ context.Context, username string, at time.Time) ([]application.StoredSession, error) {
	var out []application.StoredSession
	for _, s := range m.rows {
		if s.username == username && s.ExpiresAt.After(at) {
			out = append(out, s.StoredSession)
		}
	}
	return out, nil
}

func (m *memorySessions) EndSession(_ context.Context, username, tokenHash, _ string, audit application.SessionAudit) (bool, error) {
	before := len(m.rows)
	m.rows = slices.DeleteFunc(m.rows, func(s session) bool { return s.username == username && s.TokenHash == tokenHash })
	if len(m.rows) == before {
		return false, nil
	}
	m.audit = append(m.audit, audit)
	return true, nil
}

func (m *memorySessions) EndOtherSessions(_ context.Context, username, keep, _ string, audit func(int) application.SessionAudit) (int, error) {
	before := len(m.rows)
	m.rows = slices.DeleteFunc(m.rows, func(s session) bool { return s.username == username && s.TokenHash != keep })
	count := before - len(m.rows)
	m.audit = append(m.audit, audit(count))
	return count, nil
}

type tokens struct{}

func (tokens) NewToken() (string, error) { return "", nil }
func (tokens) Hash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func (tokens) PublicID(tokenHash string) string { return tokenHash[32:] }

type hasher struct{}

func (hasher) Hash(string) (string, error) { return "x", nil }
func (hasher) Verify(string, string) bool  { return false }
func (hasher) NeedsRehash(string) bool     { return false }

var now = time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)

const (
	tokenA1 = "a1"
	tokenA2 = "a2"
	tokenA3 = "a3"
	tokenB1 = "b1"
)

func fixture() (*application.Service, *memorySessions) {
	store := &memorySessions{}
	add := func(user, token string, minute int, google bool) {
		created := now.Add(time.Duration(minute) * time.Minute)
		store.rows = append(store.rows, session{user, application.StoredSession{
			TokenHash: tokens{}.Hash(token), CreatedAt: created, ExpiresAt: created.Add(8 * time.Hour), ViaGoogle: google,
		}})
	}
	add("admin", tokenA2, 1, true)
	add("admin", tokenA1, 0, false)
	add("admin", tokenA3, 2, false)
	add("ana", tokenB1, 3, false)
	service := application.NewService(application.Deps{
		Hasher: hasher{}, Tokens: tokens{}, Sessions: store, Now: func() time.Time { return now.Add(time.Hour) },
	})
	return service, store
}

var admin = &domain.Principal{Username: "admin", Role: domain.RoleAdmin}

func idOf(token string) string { return tokens{}.PublicID(tokens{}.Hash(token)) }

func TestListSessionsShowsOnlyOwnWithThisOneMarked(t *testing.T) {
	service, _ := fixture()
	got, err := service.ListSessions(t.Context(), "admin", tokenA1)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	var current []bool
	for _, s := range got {
		ids = append(ids, s.ID)
		current = append(current, s.Current)
	}
	// Order is the store's (newest first in SQL); the service keeps it.
	if want := []string{idOf(tokenA2), idOf(tokenA1), idOf(tokenA3)}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("ids = %v, want %v", ids, want)
	}
	if want := []bool{false, true, false}; !reflect.DeepEqual(current, want) {
		t.Fatalf("current = %v", current)
	}
	if !got[0].ViaGoogle || got[1].ViaGoogle {
		t.Fatal("via Google not carried")
	}
}

func TestEndSessionEndsOnlyOwnAndAudits(t *testing.T) {
	service, store := fixture()
	found, current, err := service.EndSession(t.Context(), admin, tokenA1, idOf(tokenA2), "SIPGES/PRJ")
	if err != nil || !found || current {
		t.Fatalf("found=%v current=%v err=%v", found, current, err)
	}
	want := application.SessionAudit{Action: "SESSION_END", RecordID: "admin",
		Detail: "Sesión " + idOf(tokenA2) + " cerrada por admin", At: now.Add(time.Hour)}
	if !reflect.DeepEqual(store.audit, []application.SessionAudit{want}) {
		t.Fatalf("audit = %+v", store.audit)
	}

	// Another user's id, an unknown id and a malformed one look the same: missing.
	for _, id := range []string{idOf(tokenB1), "0123456789abcdef0123456789abcdef", "revoke-others", ""} {
		found, _, err := service.EndSession(t.Context(), admin, tokenA1, id, "SIPGES/PRJ")
		if err != nil || found {
			t.Fatalf("%q: found=%v err=%v", id, found, err)
		}
	}
	if left, _ := store.ListSessions(t.Context(), "ana", now); len(left) != 1 {
		t.Fatal("another user's session ended")
	}
	if len(store.audit) != 1 {
		t.Fatalf("a refused id was audited: %+v", store.audit)
	}
}

func TestEndCurrentSessionReportsIt(t *testing.T) {
	service, store := fixture()
	found, current, err := service.EndSession(t.Context(), admin, tokenA3, idOf(tokenA3), "SIPGES/PRJ")
	if err != nil || !found || !current {
		t.Fatalf("found=%v current=%v err=%v", found, current, err)
	}
	if got := store.audit[0].Detail; got != "Sesión "+idOf(tokenA3)+" (este dispositivo) cerrada por admin" {
		t.Fatalf("detail = %q", got)
	}
}

func TestEndOtherSessionsKeepsThisOne(t *testing.T) {
	service, store := fixture()
	count, err := service.EndOtherSessions(t.Context(), admin, tokenA1, "SIPGES/PRJ")
	if err != nil || count != 2 {
		t.Fatalf("count=%d err=%v", count, err)
	}
	left, _ := store.ListSessions(t.Context(), "admin", now)
	if len(left) != 1 || left[0].TokenHash != (tokens{}).Hash(tokenA1) {
		t.Fatalf("left = %+v", left)
	}
	if ana, _ := store.ListSessions(t.Context(), "ana", now); len(ana) != 1 {
		t.Fatal("another user's session ended")
	}
	count, _ = service.EndOtherSessions(t.Context(), admin, tokenA1, "SIPGES/PRJ")
	if count != 0 {
		t.Fatalf("second count = %d", count)
	}
	details := []string{store.audit[0].Detail, store.audit[1].Detail}
	want := []string{"2 sesiones cerradas en otros dispositivos por admin", "0 sesiones cerradas en otros dispositivos por admin"}
	if !reflect.DeepEqual(details, want) || store.audit[0].Action != "SESSIONS_END_OTHERS" {
		t.Fatalf("audit = %+v", store.audit)
	}
}

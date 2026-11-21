package http_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
)

// untouched fails the test on any store call: the methods a password change would reach first
// record it, and the rest of the embedded nil interface would panic.
type untouched struct {
	application.Store
	application.SessionStore
	calls *int
}

func (u untouched) ReserveLoginAttempt(context.Context, application.LoginAttempt) (domain.ThrottleDecision, []int64, error) {
	*u.calls++
	return domain.ThrottleDecision{Allowed: true}, nil, nil
}

func (u untouched) FindUser(context.Context, string) (*application.StoredUser, error) {
	*u.calls++
	return nil, nil
}

func (u untouched) ReplacePassword(context.Context, string, string, string, time.Time, string, func(int) application.SessionAudit) (application.PasswordReplacement, error) {
	*u.calls++
	return application.PasswordReplaced, nil
}

// Without the current session's cookie there is no session to keep: the change would end them
// all, so it is refused before any store is reached.
func TestPasswordChangeWithoutTheSessionCookieTouchesNothing(t *testing.T) {
	calls := 0
	store := untouched{calls: &calls}
	mux := http.NewServeMux()
	identityhttp.RegisterAuth(mux, identityhttp.AuthDeps{
		Identity: application.NewBootstrapper(application.Deps{Store: store, Sessions: store}),
		TenantOf: func(*http.Request) (string, bool) { return "ACME/NORTE", true },
	})
	for _, cookie := range []string{"", identityhttp.SessionCookie + "="} {
		r := httptest.NewRequest(http.MethodPost, "/system/auth/password",
			strings.NewReader(`{"current_password":"synthetic-current-01","new_password":"synthetic-changed-02"}`))
		r.Header.Set("Content-Type", "application/json")
		if cookie != "" {
			r.Header.Set("Cookie", cookie)
		}
		r = r.WithContext(identityhttp.WithPrincipal(r.Context(), &domain.Principal{Username: "ana", Role: domain.RoleAdmin}))
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), identityhttp.SignInDetail) {
			t.Fatalf("cookie %q: %d %s", cookie, w.Code, w.Body.String())
		}
	}
	if calls != 0 {
		t.Fatalf("%d store calls without a session to keep", calls)
	}
}

// sessionGone is a store whose kept session ended between the request's sign-in and the change.
type sessionGone struct {
	application.Store
	application.SessionStore
}

func (sessionGone) ReserveLoginAttempt(context.Context, application.LoginAttempt) (domain.ThrottleDecision, []int64, error) {
	return domain.ThrottleDecision{Allowed: true}, nil, nil
}

func (sessionGone) ReleaseLoginAttempt(context.Context, []int64) error { return nil }

func (sessionGone) FindUser(_ context.Context, username string) (*application.StoredUser, error) {
	return &application.StoredUser{Username: username, Active: true, PasswordHash: "stored"}, nil
}

func (sessionGone) ReplacePassword(context.Context, string, string, string, time.Time, string, func(int) application.SessionAudit) (application.PasswordReplacement, error) {
	return application.PasswordSessionGone, nil
}

type acceptingHasher struct{}

func (acceptingHasher) Hash(string) (string, error) { return "new", nil }
func (acceptingHasher) Verify(string, string) bool  { return true }
func (acceptingHasher) NeedsRehash(string) bool     { return false }

type plainTokens struct{}

func (plainTokens) NewToken() (string, error)   { return "", nil }
func (plainTokens) Hash(token string) string    { return token }
func (plainTokens) PublicID(hash string) string { return hash }

// A session that another change or a revoke ended first cannot keep itself open: 401, as if
// signed out.
func TestPasswordChangeWhoseSessionEndedAnswersSignIn(t *testing.T) {
	mux := http.NewServeMux()
	identityhttp.RegisterAuth(mux, identityhttp.AuthDeps{
		Identity: application.NewBootstrapper(application.Deps{
			Store: sessionGone{}, Sessions: sessionGone{}, Hasher: acceptingHasher{}, Tokens: plainTokens{},
		}),
		TenantOf: func(*http.Request) (string, bool) { return "ACME/NORTE", true },
	})
	r := httptest.NewRequest(http.MethodPost, "/system/auth/password",
		strings.NewReader(`{"current_password":"synthetic-current-01","new_password":"synthetic-changed-02"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Cookie", identityhttp.SessionCookie+"="+token)
	r = r.WithContext(identityhttp.WithPrincipal(r.Context(), &domain.Principal{Username: "ana", Role: domain.RoleAdmin}))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), identityhttp.SignInDetail) {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}

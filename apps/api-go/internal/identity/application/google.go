package application

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
)

// GoogleProfile is GoogleProfile of ports.ts: the claims of a validated ID token.
type GoogleProfile struct {
	Email string
	Name  string
}

// GoogleAuthRequest is GoogleAuthRequest of ports.ts.
type GoogleAuthRequest struct {
	RedirectURI  string
	State        string
	Nonce        string
	CodeVerifier string
}

// GoogleSignIn is GoogleSignIn of ports.ts: OpenID Connect authorization code with PKCE.
type GoogleSignIn interface {
	AuthorizationURL(request GoogleAuthRequest) string
	// Exchange trades the code and validates the ID token; nil means the sign-in is refused.
	Exchange(ctx context.Context, code string, request GoogleAuthRequest, at time.Time) (*GoogleProfile, error)
}

// GoogleStore is the part of IdentityStore the Google paths use.
type GoogleStore interface {
	// FindUserByGoogleEmail returns the account linked to the address, active or not.
	FindUserByGoogleEmail(ctx context.Context, email string) (*StoredUser, error)
	// SetGoogleEmail links, or with nil unlinks, an address; a change ends the Google sessions.
	SetGoogleEmail(ctx context.Context, username string, email *string) (AccountOutcome, error)
	// LinkBootstrapGoogleEmail links email to an administrator without an address, in one
	// statement: an address already linked, or linked concurrently, is kept.
	LinkBootstrapGoogleEmail(ctx context.Context, username, email string) (BootstrapLink, error)
}

// BootstrapLink is what LinkBootstrapGoogleEmail did.
type BootstrapLink string

// The answers of linkBootstrapGoogleEmail.
const (
	LinkLinked BootstrapLink = "linked"
	LinkKept   BootstrapLink = "kept"
	LinkTaken  BootstrapLink = "taken"
)

// The refusals only the Google link has.
const (
	AccountInvalidEmail AccountOutcome = "invalid_email"
	AccountTaken        AccountOutcome = "taken"
)

// ErrBootstrapGoogleEmail stops the start: SIPGES_GOOGLE_ADMIN_EMAIL must be an address.
var ErrBootstrapGoogleEmail = errors.New("SIPGES_GOOGLE_ADMIN_EMAIL is not a valid address")

// BootstrapGoogleAdmin is bootstrapGoogleAdmin: it links the bootstrap administrator so a fresh
// installation can be reached with Google alone, and never replaces an address an administrator
// already set. The store does it atomically, so concurrent cold starts or an administrator's link
// never get clobbered.
func (s *Service) BootstrapGoogleAdmin(ctx context.Context, rawUsername, rawEmail string) error {
	username := domain.NormalizeUsername(rawUsername)
	email, ok := domain.NormalizeGoogleEmail(rawEmail)
	if !ok {
		return ErrBootstrapGoogleEmail
	}
	link, err := s.deps.Google.LinkBootstrapGoogleEmail(ctx, username, email)
	if err != nil {
		return err
	}
	if link == LinkTaken && s.deps.Logger != nil {
		s.deps.Logger.LogAttrs(ctx, slog.LevelError, "SIPGES_GOOGLE_ADMIN_EMAIL is already linked to another account")
	}
	return nil
}

// LoginWithGoogle is loginWithGoogle: a session for the active account an administrator linked to
// this verified address (ADR 0010). Unknown addresses get no account, and Result.Failure says so.
func (s *Service) LoginWithGoogle(ctx context.Context, rawEmail string) (LoginResult, error) {
	now := s.now()
	refused := LoginResult{Failure: InvalidCredentials}
	email, ok := domain.NormalizeGoogleEmail(rawEmail)
	if !ok {
		return refused, nil
	}
	user, err := s.deps.Google.FindUserByGoogleEmail(ctx, email)
	if err != nil {
		return LoginResult{}, err
	}
	if user == nil || !user.Active {
		return refused, nil
	}
	token, err := s.deps.Tokens.NewToken()
	if err != nil {
		return LoginResult{}, err
	}
	expires := now.Add(SessionSeconds * time.Second)
	created, err := s.deps.Store.CreateSession(ctx, s.deps.Tokens.Hash(token), user.Username, expires, now, true)
	if err != nil {
		return LoginResult{}, err
	}
	if !created {
		return refused, nil
	}
	if err := s.deps.Store.PurgeExpiredSessions(ctx, now); err != nil {
		return LoginResult{}, err
	}
	return LoginResult{Token: token, Username: user.Username, FullName: user.FullName, Role: user.Role}, nil
}

// LinkGoogle is linkGoogle: an administrator links, or with a blank address unlinks, an account's
// Google login. It returns the stored address.
func (s *Service) LinkGoogle(ctx context.Context, actor *domain.Principal, rawUsername, rawEmail string) (*string, AccountOutcome, error) {
	if actor.Role != domain.RoleAdmin {
		return nil, AccountForbidden, nil
	}
	username, ok := domain.AdminUsername(rawUsername)
	if !ok {
		return nil, AccountInvalid, nil
	}
	var email *string
	if !domain.IsBlank(rawEmail) {
		normalized, ok := domain.NormalizeGoogleEmail(rawEmail)
		if !ok {
			return nil, AccountInvalidEmail, nil
		}
		email = &normalized
	}
	outcome, err := s.deps.Google.SetGoogleEmail(ctx, username, email)
	if err != nil || outcome != "" {
		return nil, outcome, err
	}
	return email, "", nil
}

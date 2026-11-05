package application

import (
	"context"
	"errors"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
)

// AccountSummary is AccountSummary of ports.ts.
type AccountSummary struct {
	Username    string
	FullName    string
	Role        domain.Role
	Active      bool
	CreatedAt   time.Time
	GoogleEmail *string
}

// AccountStore is the part of IdentityStore administration uses.
type AccountStore interface {
	HasUsers(ctx context.Context) (bool, error)
	// CreateUser is false when the username already exists.
	CreateUser(ctx context.Context, account domain.NewAccount, passwordHash string, at time.Time) (bool, error)
	ListAccounts(ctx context.Context) ([]AccountSummary, error)
	// DeactivateUser atomically disables the user and deletes sessions; it serializes the
	// last-administrator guard.
	DeactivateUser(ctx context.Context, username string) (AccountOutcome, error)
	// ResetTOTPInTenant clears the factor and every session, refuses a user without a grant to
	// tenantID, and appends the audit row to that tenant's trail, in one transaction.
	ResetTOTPInTenant(ctx context.Context, username, tenantID, detail string, at time.Time) (AccountOutcome, error)
}

// AccountOutcome is what an administrative write answers; the empty value is success.
type AccountOutcome string

// The refusals of the account routes, keys of the tables in auth-routes.ts.
const (
	AccountForbidden  AccountOutcome = "forbidden"
	AccountInvalid    AccountOutcome = "invalid"
	AccountMissing    AccountOutcome = "missing"
	AccountLastAdmin  AccountOutcome = "last_admin"
	AccountSelf       AccountOutcome = "self"
	AccountOutOfScope AccountOutcome = "out_of_scope"
)

// BootstrapAdmin is the account an empty installation starts with.
type BootstrapAdmin struct {
	Username string
	Password string
	FullName string
}

// ErrBootstrapPassword stops the start of an empty installation.
var ErrBootstrapPassword = errors.New("Configure SIPGES_ADMIN_PASSWORD (mínimo 12 caracteres)") //nolint:staticcheck // the TypeScript message, byte for byte

// BootstrapAdmin is bootstrapAdmin (app.py init_auth_global): the first administrator, only on
// an empty installation.
func (s *Service) BootstrapAdmin(ctx context.Context, admin BootstrapAdmin) error {
	found, err := s.deps.Accounts.HasUsers(ctx)
	if err != nil || found {
		return err
	}
	if domain.ShortAdminPassword(admin.Password) {
		return ErrBootstrapPassword
	}
	hash, err := s.deps.Hasher.Hash(admin.Password)
	if err != nil {
		return err
	}
	account := domain.NewAccount{Username: admin.Username, FullName: admin.FullName, Role: string(domain.RoleAdmin)}
	_, err = s.deps.Accounts.CreateUser(ctx, account, hash, s.now())
	return err
}

// Logout is logout: the session of a non-empty token ends, known or not.
func (s *Service) Logout(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	return s.deps.Store.DeleteSession(ctx, s.deps.Tokens.Hash(token))
}

// ListAccounts is listAccounts.
func (s *Service) ListAccounts(ctx context.Context) ([]AccountSummary, error) {
	return s.deps.Accounts.ListAccounts(ctx)
}

// CreateResult is Result<Identity, …>: Invalid holds a refusal's text, Exists a taken username.
type CreateResult struct {
	Account domain.NewAccount
	Invalid string
	Exists  bool
}

// CreateAccount is createAccount.
func (s *Service) CreateAccount(ctx context.Context, input domain.NewAccount) (CreateResult, error) {
	account, invalid := domain.ValidateNewAccount(input)
	if invalid != "" {
		return CreateResult{Invalid: invalid}, nil
	}
	hash, err := s.deps.Hasher.Hash(account.Password)
	if err != nil {
		return CreateResult{}, err
	}
	created, err := s.deps.Accounts.CreateUser(ctx, account, hash, s.now())
	if err != nil {
		return CreateResult{}, err
	}
	return CreateResult{Account: account, Exists: !created}, nil
}

// DeactivateAccount is deactivateAccount.
func (s *Service) DeactivateAccount(ctx context.Context, actor *domain.Principal, rawUsername string) (AccountOutcome, error) {
	if actor.Role != domain.RoleAdmin {
		return AccountForbidden, nil
	}
	username, ok := domain.AdminUsername(rawUsername)
	if !ok {
		return AccountInvalid, nil
	}
	return s.deps.Accounts.DeactivateUser(ctx, username)
}

// ResetMFA is resetMfa: an administrator clears another account's second factor (lost
// authenticator). A stolen administrator session must not be able to remove its own factor
// (ADR 0009), and only users granted the active project can be reset.
func (s *Service) ResetMFA(ctx context.Context, actor *domain.Principal, rawUsername, tenantID string) (AccountOutcome, error) {
	if actor.Role != domain.RoleAdmin {
		return AccountForbidden, nil
	}
	username, ok := domain.AdminUsername(rawUsername)
	if !ok {
		return AccountInvalid, nil
	}
	if username == actor.Username {
		return AccountSelf, nil
	}
	detail := "MFA restablecido por " + actor.Username + "; sesiones revocadas"
	return s.deps.Accounts.ResetTOTPInTenant(ctx, username, tenantID, detail, s.now())
}

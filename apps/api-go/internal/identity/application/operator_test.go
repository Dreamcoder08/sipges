package application_test

import (
	"context"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
)

// Ported from the admin-cli reset-mfa case of apps/api/test/identity/deployment-hardening.test.ts:
// the operator path normalizes the name like normalizeUsername and has no actor, so neither the
// self-reset refusal nor the tenant grant of the HTTP route applies.

type operatorAccounts struct {
	application.AccountStore
	existing map[string]bool
	reset    []string
}

func (o *operatorAccounts) ResetTOTP(_ context.Context, username string) (application.AccountOutcome, error) {
	o.reset = append(o.reset, username)
	if !o.existing[username] {
		return application.AccountMissing, nil
	}
	return "", nil
}

func TestOperatorResetMFANormalizesAndReportsMissingUsers(t *testing.T) {
	t.Parallel()
	accounts := &operatorAccounts{existing: map[string]bool{"admin": true}}
	service := application.NewBootstrapper(application.Deps{Accounts: accounts})

	username, outcome, err := service.OperatorResetMFA(t.Context(), " Admin ")
	if err != nil || username != "admin" || outcome != "" {
		t.Fatalf("reset admin = %q %q %v, want admin and success", username, outcome, err)
	}
	username, outcome, err = service.OperatorResetMFA(t.Context(), "nobody")
	if err != nil || username != "nobody" || outcome != application.AccountMissing {
		t.Fatalf("reset nobody = %q %q %v, want missing", username, outcome, err)
	}
	if len(accounts.reset) != 2 || accounts.reset[0] != "admin" || accounts.reset[1] != "nobody" {
		t.Fatalf("store saw %v", accounts.reset)
	}
}

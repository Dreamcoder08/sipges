package app

import (
	"fmt"
	"net/http"
	"os"

	identity "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/application"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/infrastructure"
)

// The rest of the tenancy context (tenancy-routes.ts): project choice, the user's projects,
// project creation and grants. A grant change drops the user's copy in this process's grant
// cache at once (ForgetEverywhere); the TypeScript isolates keep theirs for up to 30 s.
func init() {
	registerContext("tenancy_admin", func(d Deps) (func(*http.ServeMux), error) {
		secure, err := cookieSecure(os.LookupEnv)
		if err != nil {
			return nil, err
		}
		deps := tenancyhttp.AdminDeps{
			Admin: application.Admin{
				Store:  tenancy.NewStore(d.Pool),
				Users:  tenancy.Users{DB: d.Pool}.Exists,
				Forget: application.ForgetEverywhere,
				Now:    d.Now,
			},
			Sessions:     identity.Sessions{DB: d.Pool, Now: d.Now},
			CookieSecure: secure,
			Logger:       d.Logger,
		}
		return func(mux *http.ServeMux) { tenancyhttp.RegisterAdmin(mux, deps) }, nil
	})
}

// cookieSecure is config.ts parseSwitch('SIPGES_COOKIE_SECURE', …, true): unset means Secure,
// otherwise exactly '0' or '1'.
func cookieSecure(lookup func(string) (string, bool)) (bool, error) {
	value, set := lookup("SIPGES_COOKIE_SECURE")
	switch {
	case !set:
		return true, nil
	case value == "0" || value == "1":
		return value == "1", nil
	}
	return false, fmt.Errorf("SIPGES_COOKIE_SECURE must be unset or exactly '0' or '1'")
}

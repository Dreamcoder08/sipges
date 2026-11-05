package app

import (
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	identity "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/secrets"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// The rest of the identity context (auth-routes.ts), beyond the session gates in app.go.
func init() {
	registerContext("identity_admin", func(d Deps) (func(*http.ServeMux), error) {
		secure, err := cookieSecure(os.LookupEnv)
		if err != nil {
			return nil, err
		}
		trustProxy, err := envSwitch(os.LookupEnv, "SIPGES_TRUST_PROXY")
		if err != nil {
			return nil, err
		}
		// Set for the container behind the Worker (goContainerEnv); no TypeScript equivalent,
		// because the Worker reads CF-Connecting-IP in code.
		edgeHeader, err := envSwitch(os.LookupEnv, "SIPGES_TRUST_CF_CONNECTING_IP")
		if err != nil {
			return nil, err
		}
		cipher, err := identityCipher(os.LookupEnv)
		if err != nil {
			return nil, err
		}
		store := identity.Store{DB: d.Pool}
		clock := d.Now
		if clock == nil {
			clock = time.Now
		}
		deps := identityhttp.AuthDeps{
			Identity: application.NewService(application.Deps{
				Store:    store,
				Accounts: store,
				Google:   store,
				Hasher:   identity.Passwords{},
				Tokens:   identity.Tokens{},
				TOTP:     identity.TOTP{},
				Cipher:   cipher,
				Logger:   d.Logger,
				Now:      d.Now,
			}),
			CookieSecure: secure,
			ClientIP:     httpx.ClientIPOptions{EdgeHeader: edgeHeader, TrustProxy: trustProxy},
			Logger:       d.Logger,
			Google:       googleSignIn(os.LookupEnv, d),
			Clock:        clock,
			TenantOf: func(r *http.Request) (string, bool) {
				scope, ok := tenancyhttp.ScopeFrom(r.Context())
				return scope.TenantID(), ok
			},
		}
		return func(mux *http.ServeMux) { identityhttp.RegisterAuth(mux, deps) }, nil
	})
}

// googleTransport reaches Google; nil means the default transport. Tests replace it.
var googleTransport http.RoundTripper

// googleSignIn is createGoogleSignIn from parseGoogle: config.Load already refused one value
// without the other. A nil interface hides the sign-in routes.
func googleSignIn(lookup func(string) (string, bool), d Deps) application.GoogleSignIn {
	id, _ := lookup("SIPGES_GOOGLE_CLIENT_ID")
	secret, _ := lookup("SIPGES_GOOGLE_CLIENT_SECRET")
	id, secret = strings.TrimSpace(id), strings.TrimSpace(secret)
	if id == "" || secret == "" {
		return nil
	}
	return identity.Google{ClientID: id, ClientSecret: secret, Transport: googleTransport, Logger: d.Logger}
}

// identityCipher seals TOTP secrets under SIPGES_DATA_KEY. Without the key the result is a nil
// interface, not a nil *Cipher: logins with MFA fail closed. A malformed key stops the start.
func identityCipher(lookup secrets.Lookup) (application.SecretCipher, error) {
	key, previous, configured, err := secrets.DataKeys(lookup)
	if err != nil || !configured {
		return nil, err
	}
	return secrets.NewCipher(key, nonEmpty(previous)...)
}

// envSwitch is parseSwitch(name, …, false): unset means off, otherwise exactly '0' or '1'.
func envSwitch(lookup func(string) (string, bool), name string) (bool, error) {
	value, set := lookup(name)
	switch {
	case !set:
		return false, nil
	case value == "0" || value == "1":
		return value == "1", nil
	}
	return false, fmt.Errorf("%s must be unset or exactly '0' or '1'", name)
}

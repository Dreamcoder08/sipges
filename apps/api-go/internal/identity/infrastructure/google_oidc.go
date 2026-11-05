package infrastructure

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

const (
	googleAuthEndpoint  = "https://accounts.google.com/o/oauth2/v2/auth"
	googleTokenEndpoint = "https://oauth2.googleapis.com/token" //nolint:gosec // a public URL, not a credential
	// googleSkewSeconds is the tolerated clock difference with Google on `exp` and `iat`.
	googleSkewSeconds = 60
	googleTimeout     = 10 * time.Second
	// maxTokenResponse bounds what is read from the token endpoint.
	maxTokenResponse = 1 << 20
)

// Google is google-oidc.ts: authorization code with PKCE. The ID token comes straight from
// Google's token endpoint over TLS, so per OpenID Connect Core 3.1.3.7 step 6 the TLS server check
// stands in for the signature; every other claim is still validated (ADR 0010).
type Google struct {
	ClientID     string
	ClientSecret string
	// Transport is the HTTP transport; nil means the default one.
	Transport http.RoundTripper
	Logger    *slog.Logger
}

// CodeChallenge is codeChallenge: RFC 7636 S256.
func CodeChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// formEncode is URLSearchParams serialization, in the order given: `*-._` stay, a space is '+'.
func formEncode(pairs ...string) string {
	var out strings.Builder
	for i := 0; i+1 < len(pairs); i += 2 {
		if i > 0 {
			out.WriteByte('&')
		}
		out.WriteString(formEscape(pairs[i]))
		out.WriteByte('=')
		out.WriteString(formEscape(pairs[i+1]))
	}
	return out.String()
}

func formEscape(s string) string {
	// encodeURIComponent keeps !~'() too; the form serializer encodes them and keeps '*'.
	escaped := httpx.EncodeURIComponent(s)
	return strings.NewReplacer("%20", "+", "!", "%21", "~", "%7E", "'", "%27", "(", "%28", ")", "%29").Replace(escaped)
}

// AuthorizationURL is authorizationUrl.
func (g Google) AuthorizationURL(request application.GoogleAuthRequest) string {
	return googleAuthEndpoint + "?" + formEncode(
		"client_id", g.ClientID,
		"redirect_uri", request.RedirectURI,
		"response_type", "code",
		"scope", "openid email profile",
		"state", request.State,
		"nonce", request.Nonce,
		"code_challenge", CodeChallenge(request.CodeVerifier),
		"code_challenge_method", "S256",
		"prompt", "select_account",
	)
}

func (g Google) log(ctx context.Context, event string, attrs ...slog.Attr) {
	if g.Logger != nil {
		g.Logger.LogAttrs(ctx, slog.LevelError, event, attrs...)
	}
}

// Exchange is exchange: nil, never an error, for anything Google refused or that fails a check.
func (g Google) Exchange(ctx context.Context, code string, request application.GoogleAuthRequest, at time.Time) (*application.GoogleProfile, error) {
	body := formEncode(
		"code", code,
		"client_id", g.ClientID,
		"client_secret", g.ClientSecret,
		"redirect_uri", request.RedirectURI,
		"grant_type", "authorization_code",
		"code_verifier", request.CodeVerifier,
	)
	ctx, cancel := context.WithTimeout(ctx, googleTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, googleTokenEndpoint, strings.NewReader(body))
	if err != nil {
		return nil, nil
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := (&http.Client{Transport: g.Transport}).Do(req)
	if err != nil {
		g.log(ctx, "Google token request failed") // the error may quote the body's URL
		return nil, nil
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		g.log(ctx, "Google token endpoint refused", slog.Int("status", res.StatusCode))
		return nil, nil
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxTokenResponse))
	if err != nil {
		return nil, nil
	}
	var answer map[string]any
	if json.Unmarshal(data, &answer) != nil {
		return nil, nil
	}
	token, ok := answer["id_token"].(string)
	if !ok {
		return nil, nil
	}
	return googleProfile(token, g.ClientID, request.Nonce, at), nil
}

// googleProfile decodes the ID token's payload and applies every check of exchange.
func googleProfile(idToken, clientID, nonce string, at time.Time) *application.GoogleProfile {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 || parts[1] == "" {
		return nil
	}
	claims := decodeClaims(parts[1])
	if claims == nil {
		return nil
	}
	now := float64(at.Unix())
	issuer, _ := claims["iss"].(string)
	audiences := audience(claims["aud"])
	exp, okExp := claims["exp"].(float64)
	iat, okIat := claims["iat"].(float64)
	if !okExp || !okIat || (issuer != "https://accounts.google.com" && issuer != "accounts.google.com") {
		return nil
	}
	if len(audiences) != 1 || audiences[0] != clientID || exp <= now-googleSkewSeconds || iat >= now+googleSkewSeconds {
		return nil
	}
	claimed, okNonce := optionalString(claims, "nonce")
	email, okEmail := optionalString(claims, "email")
	name, okName := optionalString(claims, "name")
	if !okNonce || !okEmail || !okName || claimed == nil || *claimed != nonce || email == nil || !emailVerified(claims) {
		return nil
	}
	profile := &application.GoogleProfile{Email: *email, Name: *email}
	if name != nil {
		profile.Name = *name
	}
	return profile
}

// decodeClaims is Buffer.from(payload, 'base64url') then JSON.parse: Node's decoder reads both
// alphabets and stops at padding. A claim of the wrong shape refuses the whole token.
func decodeClaims(payload string) map[string]any {
	if i := strings.IndexByte(payload, '='); i >= 0 {
		payload = payload[:i]
	}
	payload = strings.NewReplacer("+", "-", "/", "_").Replace(payload)
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return nil
	}
	var claims map[string]any
	if json.Unmarshal(raw, &claims) != nil {
		return nil
	}
	return claims
}

// audience is `aud`: one string or a list of strings; nil for any other shape.
func audience(v any) []string {
	switch aud := v.(type) {
	case string:
		return []string{aud}
	case []any:
		out := make([]string, 0, len(aud))
		for _, item := range aud {
			s, ok := item.(string)
			if !ok {
				return nil
			}
			out = append(out, s)
		}
		return out
	}
	return nil
}

// optionalString is z.string().optional(): absent is nil, and any other type, null included,
// refuses the token.
func optionalString(claims map[string]any, key string) (*string, bool) {
	v, present := claims[key]
	if !present {
		return nil, true
	}
	s, ok := v.(string)
	return &s, ok
}

// emailVerified accepts true or 'true'. z.union also admits false and 'false', which then fail.
func emailVerified(claims map[string]any) bool {
	v := claims["email_verified"]
	return v == true || v == "true"
}

package infrastructure

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/application"
)

// Ported from apps/api/test/identity/google-oidc.test.ts.

var (
	oidcAt      = time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	oidcNow     = oidcAt.Unix()
	oidcRequest = application.GoogleAuthRequest{
		RedirectURI:  "https://sipges.example/auth/google/callback",
		State:        strings.Repeat("s", 43),
		Nonce:        strings.Repeat("n", 43),
		CodeVerifier: strings.Repeat("v", 43),
	}
)

const (
	oidcClient = "client.apps.example"
	oidcSecret = "synthetic-secret"
)

func oidcClaims() map[string]any {
	return map[string]any{
		"iss": "https://accounts.google.com", "aud": oidcClient, "exp": oidcNow + 3600, "iat": oidcNow - 5,
		"nonce": oidcRequest.Nonce, "email": "persona.sintetica@example.com", "email_verified": true,
		"name": "Persona Sintética",
	}
}

func segment(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func idToken(t *testing.T, claims map[string]any) string {
	t.Helper()
	return segment(t, map[string]string{"alg": "RS256"}) + "." + segment(t, claims) + ".c2lnbmF0dXJl"
}

// roundTrip is a fake token endpoint; it keeps what SIPGES sent.
type roundTrip struct {
	status int
	body   string
	err    error
	url    string
	form   url.Values
}

func (r *roundTrip) RoundTrip(req *http.Request) (*http.Response, error) {
	r.url = req.URL.String()
	body, _ := io.ReadAll(req.Body)
	r.form, _ = url.ParseQuery(string(body))
	if r.err != nil {
		return nil, r.err
	}
	return &http.Response{StatusCode: r.status, Body: io.NopCloser(strings.NewReader(r.body)), Header: http.Header{}}, nil
}

func newGoogle(rt http.RoundTripper) Google {
	return Google{ClientID: oidcClient, ClientSecret: oidcSecret, Transport: rt}
}

func TestGoogleBuildsAnAuthorizationRequestWithPKCE(t *testing.T) {
	raw := newGoogle(nil).AuthorizationURL(oidcRequest)
	sum := sha256.Sum256([]byte(oidcRequest.CodeVerifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	// The bytes URLSearchParams writes, in its order.
	want := "https://accounts.google.com/o/oauth2/v2/auth?client_id=client.apps.example" +
		"&redirect_uri=https%3A%2F%2Fsipges.example%2Fauth%2Fgoogle%2Fcallback&response_type=code" +
		"&scope=openid+email+profile&state=" + oidcRequest.State + "&nonce=" + oidcRequest.Nonce +
		"&code_challenge=" + challenge + "&code_challenge_method=S256&prompt=select_account"
	if raw != want {
		t.Fatalf("got  %s\nwant %s", raw, want)
	}
	if strings.Contains(raw, oidcSecret) {
		t.Fatal("the client secret reached the URL")
	}
}

func TestGoogleExchangesTheCodeForTheVerifiedAddress(t *testing.T) {
	body, _ := json.Marshal(map[string]string{"id_token": idToken(t, oidcClaims()), "access_token": "x"})
	rt := &roundTrip{status: 200, body: string(body)}
	got, err := newGoogle(rt).Exchange(context.Background(), "code-1", oidcRequest, oidcAt)
	if err != nil || got == nil || got.Email != "persona.sintetica@example.com" || got.Name != "Persona Sintética" {
		t.Fatalf("got %+v, %v", got, err)
	}
	if rt.url != "https://oauth2.googleapis.com/token" {
		t.Fatalf("url %s", rt.url)
	}
	want := url.Values{"code": {"code-1"}, "client_id": {oidcClient}, "client_secret": {oidcSecret},
		"redirect_uri": {oidcRequest.RedirectURI}, "grant_type": {"authorization_code"}, "code_verifier": {oidcRequest.CodeVerifier}}
	if !maps.EqualFunc(rt.form, want, func(a, b []string) bool { return strings.Join(a, ",") == strings.Join(b, ",") }) {
		t.Fatalf("form %v", rt.form)
	}
}

func TestGoogleAcceptsTheTwoIssuersAndStringVerification(t *testing.T) {
	for _, change := range []map[string]any{
		{"iss": "accounts.google.com"},
		{"email_verified": "true"},
		{"aud": []string{oidcClient}},
		{"exp": oidcNow - 59},
		{"iat": oidcNow + 59},
	} {
		claims := oidcClaims()
		maps.Copy(claims, change)
		body, _ := json.Marshal(map[string]string{"id_token": idToken(t, claims)})
		if got, err := newGoogle(&roundTrip{status: 200, body: string(body)}).Exchange(context.Background(), "c", oidcRequest, oidcAt); err != nil || got == nil {
			t.Errorf("%v refused: %v", change, err)
		}
	}
}

func TestGoogleFallsBackToTheAddressAsName(t *testing.T) {
	claims := oidcClaims()
	delete(claims, "name")
	body, _ := json.Marshal(map[string]string{"id_token": idToken(t, claims)})
	got, err := newGoogle(&roundTrip{status: 200, body: string(body)}).Exchange(context.Background(), "c", oidcRequest, oidcAt)
	if err != nil || got == nil || got.Name != got.Email {
		t.Fatalf("got %+v, %v", got, err)
	}
}

func TestGoogleRefusesInvalidClaims(t *testing.T) {
	for name, change := range map[string]map[string]any{
		"another issuer":       {"iss": "https://evil.example"},
		"another audience":     {"aud": "other.apps.example"},
		"several audiences":    {"aud": []string{oidcClient, "other.apps.example"}},
		"no audience":          {"aud": []string{}},
		"expired":              {"exp": oidcNow - 120},
		"expired at the edge":  {"exp": oidcNow - 60},
		"issued in the future": {"iat": oidcNow + 600},
		"future at the edge":   {"iat": oidcNow + 60},
		"another nonce":        {"nonce": strings.Repeat("x", 43)},
		"no nonce":             {"nonce": nil},
		"unverified":           {"email_verified": false},
		"verified as text":     {"email_verified": "false"},
		"verified as number":   {"email_verified": 1},
		"exp as text":          {"exp": "9999999999"},
		"name as number":       {"name": 1},
		"null email":           {"email": nil},
	} {
		claims := oidcClaims()
		maps.Copy(claims, change)
		body, _ := json.Marshal(map[string]string{"id_token": idToken(t, claims)})
		got, err := newGoogle(&roundTrip{status: 200, body: string(body)}).Exchange(context.Background(), "c", oidcRequest, oidcAt)
		if err != nil || got != nil {
			t.Errorf("%s: got %+v, %v", name, got, err)
		}
	}
	claims := oidcClaims()
	delete(claims, "email")
	body, _ := json.Marshal(map[string]string{"id_token": idToken(t, claims)})
	if got, _ := newGoogle(&roundTrip{status: 200, body: string(body)}).Exchange(context.Background(), "c", oidcRequest, oidcAt); got != nil {
		t.Error("no address passed")
	}
}

func TestGoogleRefusesBadAnswers(t *testing.T) {
	for name, rt := range map[string]*roundTrip{
		"error status":     {status: 400, body: `{"error":"invalid_grant"}`},
		"server error":     {status: 500, body: `{}`},
		"no id token":      {status: 200, body: `{"access_token":"only"}`},
		"not a JWT":        {status: 200, body: `{"id_token":"not-a-jwt"}`},
		"payload not JSON": {status: 200, body: `{"id_token":"a.bm90LWpzb24.c"}`},
		"no signature":     {status: 200, body: `{"id_token":"a.e30"}`},
		"four parts":       {status: 200, body: `{"id_token":"a.e30.c.d"}`},
		"not JSON":         {status: 200, body: `not json`},
		"network down":     {err: errors.New("network down")},
	} {
		if got, err := newGoogle(rt).Exchange(context.Background(), "c", oidcRequest, oidcAt); err != nil || got != nil {
			t.Errorf("%s: got %+v, %v", name, got, err)
		}
	}
}

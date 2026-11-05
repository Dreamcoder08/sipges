package httpx

import (
	"net/http"
	"testing"
)

func TestClientIP(t *testing.T) {
	cases := []struct {
		name    string
		opts    ClientIPOptions
		headers map[string][]string
		remote  string
		want    string
	}{
		{"socket", ClientIPOptions{}, nil, "203.0.113.9:4000", "203.0.113.9"},
		{"ipv6 socket", ClientIPOptions{}, nil, "[2001:db8::1]:4000", "2001:db8::1"},
		{"no socket", ClientIPOptions{}, nil, "", "unknown"},
		{"forwarded ignored without trust", ClientIPOptions{}, map[string][]string{"X-Forwarded-For": {"198.51.100.1"}}, "203.0.113.9:1", "203.0.113.9"},
		{"cloudflare header ignored without its switch", ClientIPOptions{TrustProxy: true}, map[string][]string{"Cf-Connecting-Ip": {"198.51.100.1"}}, "203.0.113.9:1", "203.0.113.9"},
		{"right-most hop", ClientIPOptions{TrustProxy: true}, map[string][]string{"X-Forwarded-For": {"198.51.100.1, 198.51.100.2"}}, "203.0.113.9:1", "198.51.100.2"},
		{"empty hops skipped", ClientIPOptions{TrustProxy: true}, map[string][]string{"X-Forwarded-For": {"198.51.100.1, , "}}, "203.0.113.9:1", "198.51.100.1"},
		{"only empty hops", ClientIPOptions{TrustProxy: true}, map[string][]string{"X-Forwarded-For": {" , "}}, "203.0.113.9:1", "203.0.113.9"},
		{"repeated header", ClientIPOptions{TrustProxy: true}, map[string][]string{"X-Forwarded-For": {"198.51.100.1", "198.51.100.3"}}, "203.0.113.9:1", "198.51.100.3"},
		{"edge header", ClientIPOptions{EdgeHeader: true}, map[string][]string{"Cf-Connecting-Ip": {"198.51.100.1"}, "X-Forwarded-For": {"198.51.100.2"}}, "203.0.113.9:1", "198.51.100.1"},
		{"edge header missing", ClientIPOptions{EdgeHeader: true, TrustProxy: true}, map[string][]string{"X-Forwarded-For": {"198.51.100.2"}}, "203.0.113.9:1", "unknown"},
		{"bytes read as latin-1", ClientIPOptions{EdgeHeader: true}, map[string][]string{"Cf-Connecting-Ip": {"\xe9"}}, "", "é"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := &http.Request{Header: c.headers, RemoteAddr: c.remote}
			if got := ClientIP(r, c.opts); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}

func TestAuthCookie(t *testing.T) {
	cases := []struct {
		value  string
		secure bool
		want   string
	}{
		{"abc", true, "sipges_session=abc; Max-Age=28800; Path=/; HttpOnly; Secure; SameSite=Strict"},
		{"abc", false, "sipges_session=abc; Max-Age=28800; Path=/; HttpOnly; SameSite=Strict"},
		{"a/b c;ñ", false, "sipges_session=a%2Fb%20c%3B%C3%B1; Max-Age=28800; Path=/; HttpOnly; SameSite=Strict"},
	}
	for _, c := range cases {
		if got := AuthCookie("sipges_session", c.value, c.secure, 28800); got != c.want {
			t.Errorf("got %q, want %q", got, c.want)
		}
	}
}

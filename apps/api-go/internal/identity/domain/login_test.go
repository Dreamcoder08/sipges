package domain

import (
	"strings"
	"testing"
)

func TestDecideThrottle(t *testing.T) {
	cases := []struct {
		user, ip int
		allowed  bool
	}{{0, 0, true}, {4, 19, true}, {5, 0, false}, {0, 20, false}, {6, 21, false}}
	for _, c := range cases {
		got := DecideThrottle(c.user, c.ip)
		if got.Allowed != c.allowed {
			t.Errorf("%d/%d: %+v", c.user, c.ip, got)
		}
		if !got.Allowed && got.RetryAfterSeconds != 900 {
			t.Errorf("retry after = %d", got.RetryAfterSeconds)
		}
	}
}

// Expected values are what String.prototype.trim().toLowerCase() gives on Node.
func TestNormalizeUsernameLikeJavaScript(t *testing.T) {
	cases := map[string]string{
		"  Admin\t":         "admin",
		"\ufeffadmin\u00a0": "admin",
		"\u0085admin":       "\u0085admin", // not JavaScript whitespace
		"\u212Aadmin":       "kadmin",      // Kelvin sign
		"ΣΑΣ":               "σας",         // final sigma
		"İ":                 "i̇",          // U+0130 lowers to two code points
	}
	for in, want := range cases {
		if got := NormalizeUsername(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestLoginUsername(t *testing.T) {
	long := strings.Repeat("a", 121)
	cases := []struct {
		in, key    string
		lookupable bool
	}{
		{"admin", "user:admin", true},
		{strings.Repeat("a", 120), "user:" + strings.Repeat("a", 120), true},
		{strings.Repeat("😀", 60), "user:" + strings.Repeat("😀", 60), true},
		{long, "user:" + strings.Repeat("a", 120), false},
		{"a\x00b", "user:a�b", false},
		// A cut inside a surrogate pair reaches PostgreSQL as U+FFFD.
		{strings.Repeat("a", 119) + "😀", "user:" + strings.Repeat("a", 119) + "�", false},
	}
	for _, c := range cases {
		key, ok := LoginUsername(c.in)
		if key != c.key || ok != c.lookupable {
			t.Errorf("%q: got %q %v", c.in, key, ok)
		}
	}
}

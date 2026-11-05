package app

import "testing"

// config.ts parseSwitch('SIPGES_COOKIE_SECURE', …, true).
func TestCookieSecureFollowsTheTypeScriptSwitch(t *testing.T) {
	cases := []struct {
		value   string
		set     bool
		want    bool
		wantErr bool
	}{
		{"", false, true, false},
		{"1", true, true, false},
		{"0", true, false, false},
		{"", true, false, true},
		{"true", true, false, true},
		{" 1", true, false, true},
	}
	for _, c := range cases {
		got, err := cookieSecure(func(string) (string, bool) { return c.value, c.set })
		if got != c.want || (err != nil) != c.wantErr {
			t.Errorf("%q set=%v: %v, %v", c.value, c.set, got, err)
		}
	}
}

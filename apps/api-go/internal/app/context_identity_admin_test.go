package app

import "testing"

func TestEnvSwitch(t *testing.T) {
	lookup := func(values map[string]string) func(string) (string, bool) {
		return func(key string) (string, bool) { v, ok := values[key]; return v, ok }
	}
	const name = "SIPGES_TRUST_CF_CONNECTING_IP"
	for value, want := range map[string]bool{"0": false, "1": true} {
		got, err := envSwitch(lookup(map[string]string{name: value}), name)
		if err != nil || got != want {
			t.Errorf("%q: %v %v", value, got, err)
		}
	}
	if got, err := envSwitch(lookup(nil), name); err != nil || got {
		t.Errorf("unset: %v %v", got, err)
	}
	for _, value := range []string{"", "true", "yes", "2"} {
		if _, err := envSwitch(lookup(map[string]string{name: value}), name); err == nil ||
			err.Error() != name+" must be unset or exactly '0' or '1'" {
			t.Errorf("%q: %v", value, err)
		}
	}
}

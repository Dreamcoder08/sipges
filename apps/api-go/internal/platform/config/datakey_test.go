package config

import (
	"errors"
	"strings"
	"testing"
)

func lookupKey(value string, ok bool) Lookup {
	return func(string) (string, bool) { return value, ok }
}

func TestDataKey(t *testing.T) {
	padded := strings.Repeat("A", 43) + "="
	for _, value := range []string{padded, strings.Repeat("A", 43), strings.Repeat("A", 43) + "=="} {
		key, err := DataKey(lookupKey(value, true))
		if err != nil || len(key) != 32 {
			t.Errorf("DataKey(%q) = %d bytes, %v", value, len(key), err)
		}
	}
	for _, value := range []string{"", "corta", padded + "\n", strings.Repeat("A", 44), strings.Repeat("A", 42) + "==", strings.Repeat("-", 43) + "="} {
		_, err := DataKey(lookupKey(value, true))
		if err == nil || err.Error() != "SIPGES_DATA_KEY must decode to 32 bytes" {
			t.Errorf("DataKey(%q) = %v", value, err)
		}
	}
	if _, err := DataKey(lookupKey("", false)); !errors.Is(err, ErrNoDataKey) {
		t.Errorf("missing key: %v", err)
	}
}

package domain

import (
	"strings"
	"testing"
)

// The temporary password an administrator's reset hands over (world-class-local T8d): 20
// characters a person can read aloud without confusing them, accepted by the change policy.
func TestNewTemporaryPassword(t *testing.T) {
	seen := map[string]bool{}
	for range 200 {
		password, err := NewTemporaryPassword("ana.perez")
		if err != nil {
			t.Fatal(err)
		}
		if len(password) != TemporaryPasswordLength {
			t.Fatalf("%q has %d characters, want %d", password, len(password), TemporaryPasswordLength)
		}
		if strings.Trim(password, TemporaryPasswordAlphabet) != "" {
			t.Fatalf("%q has a character outside the alphabet", password)
		}
		if detail := CheckNewPassword("ana.perez", "", password); detail != "" {
			t.Fatalf("%q breaks the policy: %s", password, detail)
		}
		if seen[password] {
			t.Fatalf("%q came twice", password)
		}
		seen[password] = true
	}
	if TemporaryPasswordLength != 20 || strings.ContainsAny(TemporaryPasswordAlphabet, "0O1IlL8B") {
		t.Fatalf("length %d, alphabet %q: want 20 characters and no look-alikes", TemporaryPasswordLength, TemporaryPasswordAlphabet)
	}
}

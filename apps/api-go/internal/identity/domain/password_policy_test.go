package domain

import (
	"strings"
	"testing"
)

// The new-password policy of a password change (NIST SP 800-63B-4): length, not the username,
// not the current password, not a common password. Synthetic passwords only.
func TestCheckNewPassword(t *testing.T) {
	const (
		username = "ana.perez"
		current  = "synthetic-current-01"
	)
	for _, c := range []struct {
		name, candidate, want string
	}{
		{"12 characters", "synthetic-12", ""},
		{"128 characters", strings.Repeat("z", 128), ""},
		{"128 code points", strings.Repeat("ñ", 128), ""},
		{"11 characters", "synthetic-1", PasswordTooShort},
		{"11 code points", strings.Repeat("😀", 11), PasswordTooShort},
		{"129 characters", strings.Repeat("z", 129), PasswordTooLongForChange},
		{"contains the username but is longer", username + "-2026", ""},
		{"equal to the current password", current, PasswordSameAsCurrent},
		{"common password", "qwerty123456", PasswordTooCommon},
		{"common password in capitals", "QWERTY123456", PasswordTooCommon},
		{"common password, other entry", "1q2w3e4r5t6y", PasswordTooCommon},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := CheckNewPassword(username, current, c.candidate); got != c.want {
				t.Fatalf("CheckNewPassword(%q) = %q, want %q", c.candidate, got, c.want)
			}
		})
	}
	long := "synthetic.username"
	for _, candidate := range []string{long, strings.ToUpper(long)} {
		if got := CheckNewPassword(long, current, candidate); got != PasswordSameAsUsername {
			t.Errorf("username %q as the password: %q", candidate, got)
		}
	}
}

// The details a person reads, in neutral Spanish.
func TestNewPasswordDetails(t *testing.T) {
	for got, want := range map[string]string{
		PasswordTooShort:         "Contraseña demasiado corta: mínimo 12 caracteres",
		PasswordTooLongForChange: "Contraseña demasiado larga: máximo 128 caracteres",
		PasswordSameAsUsername:   "La contraseña no puede ser igual al nombre de usuario",
		PasswordSameAsCurrent:    "La nueva contraseña debe ser distinta de la actual",
		PasswordTooCommon:        "La contraseña es demasiado común; elija otra",
	} {
		if got != want {
			t.Errorf("%q, want %q", got, want)
		}
	}
}

// The embedded list is a few hundred lower-case entries, none shorter than the minimum (those
// could never be reached).
func TestCommonPasswordsList(t *testing.T) {
	list := commonPasswords()
	if n := len(list); n < 200 || n > 1000 {
		t.Fatalf("%d common passwords", n)
	}
	for entry := range list {
		if entry != lower(entry) || len([]rune(entry)) < PasswordMin {
			t.Errorf("entry %q", entry)
		}
	}
}

package domain

import (
	_ "embed" // the common-password list
	"strings"
	"sync"
	"unicode/utf8"
)

// NewPasswordMax bounds a changed password, in code points: NIST SP 800-63B-4 asks verifiers to
// accept at least 64 characters, and 128 keeps the hashing cost of a change small.
const NewPasswordMax = 128

// The refusals of a new password, one per rule.
//
//nolint:gosec // refusal messages, not credentials
const (
	PasswordTooShort         = "Contraseña demasiado corta: mínimo 12 caracteres"
	PasswordTooLongForChange = "Contraseña demasiado larga: máximo 128 caracteres"
	PasswordSameAsUsername   = "La contraseña no puede ser igual al nombre de usuario"
	PasswordSameAsCurrent    = "La nueva contraseña debe ser distinta de la actual"
	PasswordTooCommon        = "La contraseña es demasiado común; elija otra"
)

//go:embed common_passwords.txt
var commonPasswordsText string

// commonPasswords is the embedded list as a set, parsed on first use.
var commonPasswords = sync.OnceValue(func() map[string]struct{} {
	set := map[string]struct{}{}
	for line := range strings.Lines(commonPasswordsText) {
		entry := strings.TrimRight(line, "\r\n")
		if entry == "" || strings.HasPrefix(entry, "#") {
			continue
		}
		set[lower(entry)] = struct{}{}
	}
	return set
})

// CheckNewPassword is the policy of a password change (NIST SP 800-63B-4 §3.1.1.2): 12 to 128
// characters, not the username, not the current password, not a common password. It returns the
// refusal's detail, or "" when candidate is accepted. The username and common-password checks
// ignore case; the current-password check is exact, as the hash compares it.
func CheckNewPassword(username, current, candidate string) string {
	folded := lower(candidate)
	_, common := commonPasswords()[folded]
	switch length := utf8.RuneCountInString(candidate); {
	case length < PasswordMin:
		return PasswordTooShort
	case length > NewPasswordMax:
		return PasswordTooLongForChange
	case folded == lower(username):
		return PasswordSameAsUsername
	case candidate == current:
		return PasswordSameAsCurrent
	case common:
		return PasswordTooCommon
	}
	return ""
}

package domain

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// Password length, in Unicode code points like Python len(); the upper bound keeps hashing cost
// bounded (ADR 0004).
const (
	PasswordMin = 12
	PasswordMax = 256
)

const fullNameMax = 120

var usernamePattern = regexp.MustCompile(`^[a-z0-9_.-]{3,40}$`)

// NewAccount is NewAccount of user.ts, before validation holding any role text.
type NewAccount struct {
	Username string
	FullName string
	Password string
	Role     string
}

func isRole(role string) bool {
	switch Role(role) {
	case RoleAdmin, RoleAnalyst, RoleCoordinator, RoleReadOnly:
		return true
	}
	return false
}

// ValidateNewAccount is validateNewAccount (app.py:298-302, plus the ADR 0004 maximum length):
// the account with its name cut, or the refusal's text.
func ValidateNewAccount(input NewAccount) (NewAccount, string) {
	switch length := utf8.RuneCountInString(input.Password); {
	case !usernamePattern.MatchString(input.Username):
		return NewAccount{}, "Usuario inválido"
	case !isRole(input.Role):
		return NewAccount{}, "Rol no válido"
	case length < PasswordMin:
		return NewAccount{}, "Contraseña demasiado corta: mínimo 12 caracteres"
	case length > PasswordMax:
		return NewAccount{}, "Contraseña demasiado larga: máximo 256 caracteres"
	}
	input.FullName = slice16(input.FullName, fullNameMax)
	return input, ""
}

// AdminUsername is the check of deactivateAccount and resetMfa: the normalized name of a path
// parameter, ok=false when no stored account could have it.
func AdminUsername(raw string) (string, bool) {
	username := NormalizeUsername(raw)
	if username == "" || strings.ContainsRune(username, 0) || units16(username) > MaxStoredUsername {
		return "", false
	}
	return username, true
}

// StorableUsername is the CHECK of users.username (migration 0001): char_length, in code points.
func StorableUsername(username string) bool {
	return username != "" && utf8.RuneCountInString(username) <= MaxStoredUsername
}

// ShortAdminPassword is the bootstrap check: PASSWORD_MIN over the JavaScript length.
func ShortAdminPassword(password string) bool { return units16(password) < PasswordMin }

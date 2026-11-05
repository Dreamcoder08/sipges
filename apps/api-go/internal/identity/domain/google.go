package domain

import (
	"regexp"
	"strings"
)

const googleEmailMax = 254

// jsNotSpaceOrAt is JavaScript's [^\s@]: Go's \s is ASCII only.
const jsNotSpaceOrAt = `[^\t\n\x{b}\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}@]+`

var emailPattern = regexp.MustCompile(`^` + jsNotSpaceOrAt + `@` + jsNotSpaceOrAt + `\.` + jsNotSpaceOrAt + `$`)

// NormalizeGoogleEmail is normalizeGoogleEmail: a Google address an administrator links to an
// account, compared in lower case (ADR 0010); ok=false for the "Correo de Google inválido" case.
func NormalizeGoogleEmail(raw string) (string, bool) {
	email := NormalizeUsername(raw) // the same trim and lower case
	if units16(email) > googleEmailMax || strings.ContainsRune(email, 0) || !emailPattern.MatchString(email) {
		return "", false
	}
	return email, true
}

// IsBlank is rawEmail.trim() === ”: an empty address unlinks.
func IsBlank(raw string) bool { return strings.TrimFunc(raw, isJSSpace) == "" }

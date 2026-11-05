package domain

import (
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

// Failed-login limits within a sliding window (login-throttle.ts, ADR 0004).
const (
	MaxFailuresPerUser = 5
	MaxFailuresPerIP   = 20
	ThrottleWindow     = 900 // seconds
)

// MaxStoredUsername is the upper bound of the users table (migration 0001), in UTF-16 units.
const MaxStoredUsername = 120

// ThrottleDecision is ThrottleDecision of login-throttle.ts; RetryAfterSeconds only applies to a
// refused attempt.
type ThrottleDecision struct {
	Allowed           bool
	RetryAfterSeconds int
}

// DecideThrottle is throttleDecision.
func DecideThrottle(userFailures, ipFailures int) ThrottleDecision {
	if userFailures >= MaxFailuresPerUser || ipFailures >= MaxFailuresPerIP {
		return ThrottleDecision{RetryAfterSeconds: ThrottleWindow}
	}
	return ThrottleDecision{Allowed: true}
}

// UserSubject is userSubject.
func UserSubject(username string) string { return "user:" + username }

// IPSubject is ipSubject.
func IPSubject(ip string) string { return "ip:" + ip }

// isJSSpace is JavaScript's String.prototype.trim set; unlike unicode.IsSpace it includes U+FEFF
// and excludes U+0085.
func isJSSpace(r rune) bool {
	return r == 0xfeff || (unicode.IsSpace(r) && r != 0x85)
}

// lower is String.prototype.toLowerCase: the Unicode default mapping, with its final sigma and
// U+0130 rules, which strings.ToLower lacks. A Caser holds state, so each call gets a fresh one.
func lower(s string) string { return cases.Lower(language.Und).String(s) }

// NormalizeUsername is user.ts normalizeUsername: trim, then lower case.
func NormalizeUsername(raw string) string {
	return lower(strings.TrimFunc(raw, isJSSpace))
}

// units16 is a string's JavaScript length, in UTF-16 code units.
func units16(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// slice16 is s.slice(0, n) by UTF-16 code units as it reaches PostgreSQL: a cut inside a
// surrogate pair leaves a lone surrogate, which the driver's UTF-8 encoding writes as U+FFFD.
func slice16(s string, n int) string {
	units := 0
	for i, r := range s {
		size := utf16.RuneLen(r)
		if units+size > n {
			if size == 2 && units+1 == n {
				return s[:i] + string(utf8.RuneError)
			}
			return s[:i]
		}
		units += size
	}
	return s
}

// LoginUsername is the first step of identity-service.ts login. PostgreSQL text cannot hold NUL
// and stored names are at most 120 characters: such a name cannot exist, so it is not lookupable
// and is treated as an unknown user under a sanitized throttle key.
func LoginUsername(normalized string) (throttleKey string, lookupable bool) {
	if !strings.ContainsRune(normalized, 0) && units16(normalized) <= MaxStoredUsername {
		return UserSubject(normalized), true
	}
	return UserSubject(slice16(strings.ReplaceAll(normalized, "\x00", "�"), MaxStoredUsername)), false
}

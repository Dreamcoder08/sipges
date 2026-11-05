package domain

import (
	"regexp"
	"unicode/utf8"
)

// DefaultScope is DEFAULT_SCOPE: the legacy project of the Python installation (app.py
// bootstrap). It can never be created again.
var DefaultScope = Scope{CompanyID: "SIPGES", ProjectID: "PRJ-SECHURA"}

// idPattern is ID_PATTERN. Go's $ matches only at the end of the text, like JavaScript's
// without the m flag, so "ACME\n" is refused.
var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{2,64}$`)

// labelMax is LABEL_MAX, in UTF-16 code units.
const labelMax = 120

// The errors of validateNewTenant.
const (
	ErrInvalidIDs = "invalid_ids"
	ErrReserved   = "reserved"
)

// NewTenant is a project to create and the user who receives its first grant.
type NewTenant struct {
	Scope
	Label    string
	Username string
}

// ValidateNewTenant is validateNewTenant (app.py:355-361): both ids match ID_PATTERN, the
// default project is reserved, and the label is cut to 120 UTF-16 code units. It returns ""
// or one of ErrInvalidIDs, ErrReserved.
func ValidateNewTenant(in NewTenant) (NewTenant, string) {
	if !idPattern.MatchString(in.CompanyID) || !idPattern.MatchString(in.ProjectID) {
		return NewTenant{}, ErrInvalidIDs
	}
	if in.Scope == DefaultScope {
		return NewTenant{}, ErrReserved
	}
	in.Label = slice16(in.Label, labelMax)
	return in, ""
}

// slice16 is String.prototype.slice(0, n) as the stored text: a cut through a surrogate pair
// leaves a lone surrogate, which the TypeScript driver encodes as U+FFFD, as written here.
func slice16(s string, n int) string {
	units := 0
	for i, r := range s {
		size := 1
		if r > 0xFFFF {
			size = 2
		}
		if units+size > n {
			if units < n { // half of a surrogate pair fits
				return s[:i] + string(utf8.RuneError)
			}
			return s[:i]
		}
		units += size
	}
	return s
}

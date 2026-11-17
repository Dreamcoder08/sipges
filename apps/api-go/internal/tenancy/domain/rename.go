package domain

import (
	"strings"
	"unicode"
)

// ErrInvalidLabel refuses a project name that is empty once trimmed.
const ErrInvalidLabel = "invalid_label"

// The audit row of a rename, in the renamed project's own trail.
const (
	RenameAuditModule = "Proyectos"
	RenameAuditAction = "RENAME"
)

// ValidateLabel is validateLabel of scope.ts: the name trimmed as String.prototype.trim does,
// refused when nothing is left, then cut to LABEL_MAX UTF-16 code units as creation cuts it.
// It returns the stored name, or "" and ErrInvalidLabel.
func ValidateLabel(label string) (string, string) {
	trimmed := strings.TrimFunc(label, isJSSpace)
	if trimmed == "" {
		return "", ErrInvalidLabel
	}
	return slice16(trimmed, labelMax), ""
}

// isJSSpace is the WhiteSpace and LineTerminator set of ECMAScript: Go's White_Space without
// U+0085, plus U+FEFF.
func isJSSpace(r rune) bool {
	return r == 0xFEFF || (r != 0x85 && unicode.IsSpace(r))
}

// RenameDetail is the audit text of a rename.
func RenameDetail(previous, label, by string) string {
	return "Proyecto renombrado de «" + previous + "» a «" + label + "» por " + by
}

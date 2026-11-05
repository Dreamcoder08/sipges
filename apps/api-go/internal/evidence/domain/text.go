package domain

import (
	"unicode/utf16"
	"unicode/utf8"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/doctext"
)

// DecodeUTF8 is the WHATWG UTF-8 decoder of TextDecoder and Buffer#toString (doctext.DecodeUTF8,
// shared with the document reader).
func DecodeUTF8(b []byte, stripBOM bool) string { return doctext.DecodeUTF8(b, stripBOM) }

// SliceStored is value.slice(0, n) by UTF-16 code units as it reaches PostgreSQL: a cut inside
// a surrogate pair leaves a lone surrogate, which the driver's UTF-8 encoding writes as U+FFFD.
func SliceStored(s string, n int) string {
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

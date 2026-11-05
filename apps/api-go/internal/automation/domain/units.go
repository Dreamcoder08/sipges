package domain

import (
	"unicode/utf16"
	"unicode/utf8"
)

// Strings in this package may hold lone UTF-16 surrogates in WTF-8 (ED A0–BF xx), as the
// records context's JSON reader keeps them (records/domain/js.go) and as a JavaScript slice can
// leave them. The helpers below read and write strings as JavaScript sees them: UTF-16 code
// units.

// Units is the string as JavaScript's UTF-16 code units.
func Units(s string) []uint16 {
	out := make([]uint16, 0, len(s))
	for i := 0; i < len(s); {
		if u, ok := surrogate(s, i); ok {
			out = append(out, u)
			i += 3
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		i += size
		if r >= 0x10000 {
			hi, lo := utf16.EncodeRune(r)
			out = append(out, uint16(hi), uint16(lo)) //nolint:gosec // surrogates fit in 16 bits
			continue
		}
		out = append(out, uint16(r)) //nolint:gosec // a BMP rune fits in 16 bits
	}
	return out
}

// FromUnits writes UTF-16 code units back: pairs as UTF-8, lone surrogates as WTF-8.
func FromUnits(units []uint16) string {
	b := make([]byte, 0, len(units))
	for i := 0; i < len(units); i++ {
		u := units[i]
		if utf16.IsSurrogate(rune(u)) {
			if u < 0xdc00 && i+1 < len(units) && units[i+1] >= 0xdc00 && units[i+1] <= 0xdfff {
				b = utf8.AppendRune(b, utf16.DecodeRune(rune(u), rune(units[i+1])))
				i++
				continue
			}
			b = append(b, 0xed, byte(0xa0|(u>>6)&0x1f), byte(0x80|u&0x3f)) //nolint:gosec // masked
			continue
		}
		b = utf8.AppendRune(b, rune(u))
	}
	return string(b)
}

// Len16 is String.prototype.length.
func Len16(s string) int { return len(Units(s)) }

// Slice16 is s.slice(0, n).
func Slice16(s string, n int) string {
	u := Units(s)
	if len(u) <= n {
		return s
	}
	return FromUnits(u[:n])
}

// Less16 is JavaScript's `a < b` on strings: UTF-16 code unit order.
func Less16(a, b string) bool {
	ua, ub := Units(a), Units(b)
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

// PGText is the text postgres.js sends for a JavaScript string: UTF-8, each lone surrogate as
// U+FFFD (Buffer.from). PostgreSQL refuses the WTF-8 bytes themselves.
func PGText(s string) string {
	for i := 0; i < len(s); i++ {
		if _, ok := surrogate(s, i); ok {
			return FromUnitsReplacing(Units(s))
		}
	}
	return s
}

// FromUnitsReplacing writes UTF-16 code units as UTF-8 with each lone surrogate as U+FFFD.
func FromUnitsReplacing(units []uint16) string {
	return string(utf16.Decode(units)) // utf16.Decode maps lone surrogates to U+FFFD
}

func surrogate(s string, i int) (uint16, bool) {
	if i+2 >= len(s) || s[i] != 0xed || s[i+1] < 0xa0 || s[i+1] > 0xbf || s[i+2] < 0x80 || s[i+2] > 0xbf {
		return 0, false
	}
	return 0xd000 | uint16(s[i+1]&0x3f)<<6 | uint16(s[i+2]&0x3f), true
}

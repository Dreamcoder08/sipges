package domain

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"

	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// JavaScript string and regular expression semantics the integration rules depend on.

// jsSpace is JavaScript's \s, which also matches Unicode spaces, unlike RE2's ASCII \s.
const jsSpace = `\t\n\x0B\f\r \x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}`

// ci spells an ASCII word case-insensitively for RE2, as JavaScript's /i reads it (RE2's (?i)
// also folds non-ASCII letters such as U+212A KELVIN SIGN into k, which /i does not).
func ci(word string) string {
	var b strings.Builder
	for _, r := range word {
		lower, upper := strings.ToLower(string(r)), strings.ToUpper(string(r))
		if lower == upper {
			b.WriteString(regexp.QuoteMeta(string(r)))
			continue
		}
		b.WriteString("[" + lower + upper + "]")
	}
	return b.String()
}

// TrimJS is String.prototype.trim.
func TrimJS(s string) string { return js.TrimJS(s) }

// Len16 is a string's JavaScript length, in UTF-16 code units.
func Len16(s string) int { return js.Len16(s) }

// Slice16 is s.slice(0, n) in UTF-16 code units. A cut inside a surrogate pair keeps its high
// surrogate, as JavaScript does, in the WTF-8 form the records context uses for lone surrogates.
func Slice16(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r > 0xFFFF {
			w = 2
		}
		if units+w > n {
			if w == 2 && units+1 == n {
				high, _ := utf16.EncodeRune(r)
				return s[:i] + wtf8(high)
			}
			return s[:i]
		}
		units += w
	}
	return s
}

// wtf8 is the three-byte form of a lone surrogate code unit (records.WellFormed reads it).
func wtf8(unit rune) string {
	return string([]byte{0xED, byte(0x80 | (unit>>6)&0x3F), byte(0x80 | unit&0x3F)}) //nolint:gosec // six-bit masks
}

// fromCodePoint is String.fromCodePoint for a code point the caller checked to be in range; a
// lone surrogate keeps its WTF-8 form.
func fromCodePoint(code int64) string {
	r := rune(code) //nolint:gosec // callers check 0 < code <= 0x10FFFF
	if utf16.IsSurrogate(r) {
		return wtf8(r)
	}
	return string(r)
}

var (
	jsDecimal = regexp.MustCompile(`^[+-]?(Infinity|[0-9]+\.?[0-9]*([eE][+-]?[0-9]+)?|\.[0-9]+([eE][+-]?[0-9]+)?)$`)
	jsRadix   = regexp.MustCompile(`^0([xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)$`)
)

// NumberJS is Number(s) for a string: JavaScript whitespace trimmed, empty is 0, decimal or
// 0x/0o/0b literals, anything else NaN.
func NumberJS(s string) float64 {
	s = TrimJS(s)
	switch {
	case s == "":
		return 0
	case jsRadix.MatchString(s):
		base := map[byte]int{'x': 16, 'o': 8, 'b': 2}[s[1]|0x20]
		f := 0.0
		for _, c := range strings.ToLower(s[2:]) {
			d, _ := strconv.ParseUint(string(c), base, 8)
			f = f*float64(base) + float64(d)
		}
		return f
	case jsDecimal.MatchString(s):
		if strings.HasSuffix(s, "Infinity") {
			if s[0] == '-' {
				return math.Inf(-1)
			}
			return math.Inf(1)
		}
		f, _ := strconv.ParseFloat(s, 64)
		return f
	}
	return math.NaN()
}

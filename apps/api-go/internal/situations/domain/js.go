package domain

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

// The helpers below read decoded JSON (any, with json.Number numbers) the way the TypeScript
// domain reads the values JSON.parse gave it, so the Go port answers byte for byte.

// IsJSSpace reports whether r is in JavaScript's \s and String.prototype.trim set: WhiteSpace and
// LineTerminator. Unlike unicode.IsSpace it includes U+FEFF and excludes U+0085.
func IsJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// TrimJS is String.prototype.trim.
func TrimJS(s string) string { return strings.TrimFunc(s, IsJSSpace) }

// JSNumber is Number.prototype.toString for a JSON number (JSON.parse reads 1e400 as Infinity).
func JSNumber(f float64) string {
	switch {
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case math.IsNaN(f):
		return "NaN"
	case f == 0:
		return "0" // also -0
	}
	if abs := math.Abs(f); abs >= 1e-6 && abs < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	s := strconv.FormatFloat(f, 'e', -1, 64) // 1e+21, 1.5e-07
	mantissa, exp, _ := strings.Cut(s, "e")
	sign := exp[0]
	exp = strings.TrimLeft(exp[1:], "0")
	return mantissa + "e" + string(sign) + exp
}

// Float is the float64 JSON.parse gives for a decoded number.
func Float(n json.Number) float64 {
	f, err := strconv.ParseFloat(string(n), 64)
	if err != nil && !math.IsInf(f, 0) {
		return math.NaN() // unreachable for numbers PostgreSQL stored in jsonb
	}
	return f
}

// Number is the value as a JavaScript number, and whether it is one.
func Number(v any) (float64, bool) {
	switch x := v.(type) {
	case json.Number:
		return Float(x), true
	case float64:
		return x, true
	}
	return 0, false
}

// JSString is String(value ?? ”) for a decoded JSON value.
func JSString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case json.Number, float64:
		f, _ := Number(x)
		return JSNumber(f)
	case []any:
		parts := make([]string, len(x))
		for i, item := range x {
			parts[i] = JSString(item) // null elements join as ""
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

var (
	lower = cases.Lower(language.Und)
	upper = cases.Upper(language.Und)
)

// LowerJS is String.prototype.toLowerCase (full Unicode mapping, final sigma included).
func LowerJS(s string) string { return lower.String(s) }

// UpperJS is String.prototype.toUpperCase (full mapping: ß becomes SS).
func UpperJS(s string) string { return upper.String(s) }

// Fold is fold of signals.ts: NFD, without nonspacing marks, lower case, whitespace runs as one
// space, trimmed.
func Fold(v any) string {
	decomposed := norm.NFD.String(JSString(v))
	var b strings.Builder
	for _, r := range decomposed {
		if !unicode.Is(unicode.Mn, r) {
			b.WriteRune(r)
		}
	}
	lowered := LowerJS(b.String())
	b.Reset()
	space := false
	for _, r := range lowered {
		if IsJSSpace(r) {
			space = true
			continue
		}
		if space && b.Len() > 0 {
			b.WriteByte(' ')
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}

// Len16 is a string's JavaScript length (UTF-16 code units).
func Len16(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// Less16 is JavaScript's a < b on strings: by UTF-16 code units, which orders U+E000–U+FFFF
// after the supplementary planes where a UTF-8 byte comparison would not.
func Less16(a, b string) bool {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

// RoundJS is Math.round: halves round towards +∞.
func RoundJS(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

// ReplaceAllJS is s.replaceAll(search, replacement) with a string search: the replacement's $$,
// $&, $` and $' patterns expand as in JavaScript (GetSubstitution); anything else is literal.
func ReplaceAllJS(s, search, replacement string) string {
	if search == "" || !strings.Contains(s, search) {
		return s
	}
	var b strings.Builder
	rest := 0
	for {
		i := strings.Index(s[rest:], search)
		if i < 0 {
			break
		}
		at := rest + i
		b.WriteString(s[rest:at])
		b.WriteString(substitute(replacement, s, search, at))
		rest = at + len(search)
	}
	b.WriteString(s[rest:])
	return b.String()
}

func substitute(replacement, s, matched string, at int) string {
	if !strings.Contains(replacement, "$") {
		return replacement
	}
	var b strings.Builder
	for i := 0; i < len(replacement); i++ {
		c := replacement[i]
		if c != '$' || i+1 == len(replacement) {
			b.WriteByte(c)
			continue
		}
		switch replacement[i+1] {
		case '$':
			b.WriteByte('$')
		case '&':
			b.WriteString(matched)
		case '`':
			b.WriteString(s[:at])
		case '\'':
			b.WriteString(s[at+len(matched):])
		default:
			b.WriteByte('$')
			continue
		}
		i++
	}
	return b.String()
}

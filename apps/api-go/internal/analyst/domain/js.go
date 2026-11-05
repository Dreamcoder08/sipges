package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// JavaScript string semantics the TypeScript domain relies on. A JavaScript string is a sequence
// of UTF-16 code units and a slice can cut a surrogate pair; such a lone surrogate is held here in
// WTF-8 (ED A0–BF xx), so a Go string carries it and Text writes it as JSON.stringify does. The
// helpers mirror internal/situations/domain/js.go, which another context owns.

// isJSSpace reports whether r is in JavaScript's \s and String.prototype.trim set.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// jsSpaceClass is JavaScript's \s as a Go regexp class (Go's \s is ASCII only).
const jsSpaceClass = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

// trimJS is String.prototype.trim.
func trimJS(s string) string { return strings.TrimFunc(s, isJSSpace) }

// collapseSpaces is s.replace(/\s+/g, ' ').
func collapseSpaces(s string) string {
	var b strings.Builder
	space := false
	for _, r := range codePoints(s) {
		if isJSSpace(r) {
			space = true
			continue
		}
		if space {
			b.WriteByte(' ')
			space = false
		}
		writePoint(&b, r)
	}
	if space {
		b.WriteByte(' ')
	}
	return b.String()
}

// codePoints is Array.from(s): code points, a lone surrogate as its own element.
func codePoints(s string) []rune {
	out := make([]rune, 0, len(s))
	for i := 0; i < len(s); {
		if r, ok := surrogateAt(s, i); ok {
			out = append(out, r)
			i += 3
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		out = append(out, r)
		i += size
	}
	return out
}

// surrogateAt reads a WTF-8 surrogate at s[i:].
func surrogateAt(s string, i int) (rune, bool) {
	if i+2 < len(s) && s[i] == 0xed && s[i+1] >= 0xa0 && s[i+1] <= 0xbf && s[i+2] >= 0x80 && s[i+2] <= 0xbf {
		return 0xd000 | rune(s[i+1]&0x3f)<<6 | rune(s[i+2]&0x3f), true
	}
	return 0, false
}

// writePoint appends a code point, a surrogate in WTF-8.
func writePoint(b *strings.Builder, r rune) {
	if r >= 0xd800 && r <= 0xdfff {
		b.Write([]byte{0xed, byte(0xa0 | (r>>6)&0x1f), byte(0x80 | r&0x3f)}) //nolint:gosec // masked
		return
	}
	b.WriteRune(r)
}

// fromPoints joins code points back into a string.
func fromPoints(points []rune) string {
	var b strings.Builder
	for _, r := range points {
		writePoint(&b, r)
	}
	return b.String()
}

// units is s as UTF-16 code units.
func units(s string) []uint16 {
	out := make([]uint16, 0, len(s))
	for _, r := range codePoints(s) {
		if r >= 0x10000 {
			hi, lo := utf16.EncodeRune(r)
			out = append(out, uint16(hi), uint16(lo)) //nolint:gosec // surrogates fit
			continue
		}
		out = append(out, uint16(r)) //nolint:gosec // BMP
	}
	return out
}

// fromUnits is the string of UTF-16 code units, lone surrogates kept.
func fromUnits(u []uint16) string {
	var b strings.Builder
	for i := 0; i < len(u); i++ {
		c := rune(u[i])
		if utf16.IsSurrogate(c) && c < 0xdc00 && i+1 < len(u) && u[i+1] >= 0xdc00 && u[i+1] <= 0xdfff {
			b.WriteRune(utf16.DecodeRune(c, rune(u[i+1])))
			i++
			continue
		}
		writePoint(&b, c)
	}
	return b.String()
}

// len16 is s.length.
func len16(s string) int {
	n := 0
	for _, r := range codePoints(s) {
		n++
		if r >= 0x10000 {
			n++
		}
	}
	return n
}

// slice16 is s.slice(start, end) by UTF-16 code units.
func slice16(s string, start, end int) string {
	u := units(s)
	start = max(0, min(start, len(u)))
	end = max(start, min(end, len(u)))
	return fromUnits(u[start:end])
}

// hasSurrogate reports whether s holds a lone surrogate.
func hasSurrogate(s string) bool {
	for i := range len(s) {
		if _, ok := surrogateAt(s, i); ok {
			return true
		}
	}
	return false
}

// jsNumber is Number.prototype.toString for a JSON number (JSON.parse reads 1e400 as Infinity).
func jsNumber(f float64) string {
	switch {
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case math.IsNaN(f):
		return "NaN"
	case f == 0:
		return "0"
	}
	if abs := math.Abs(f); abs >= 1e-6 && abs < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	s := strconv.FormatFloat(f, 'e', -1, 64)
	mantissa, exp, _ := strings.Cut(s, "e")
	sign := exp[0]
	exp = strings.TrimLeft(exp[1:], "0")
	return mantissa + "e" + string(sign) + exp
}

// numberOf is the float64 JSON.parse gives for a decoded number.
func numberOf(n json.Number) float64 {
	f, err := strconv.ParseFloat(string(n), 64)
	if err != nil && !math.IsInf(f, 0) {
		return math.NaN()
	}
	return f
}

var (
	lower = cases.Lower(language.Und)
	// A collator holds buffers, so requests served at once must not share one.
	collators = sync.Pool{New: func() any { return collate.New(language.Und) }}
)

// lowerJS is String.prototype.toLowerCase (full Unicode mapping).
func lowerJS(s string) string { return lower.String(s) }

// localeCompare is a.localeCompare(b) under the root collation Node's ICU applies by default,
// as -1, 0 or 1.
func localeCompare(a, b string) int {
	collator, _ := collators.Get().(*collate.Collator)
	defer collators.Put(collator)
	return collator.CompareString(a, b)
}

// Text is a string that may hold WTF-8 lone surrogates; it marshals them as JSON.stringify
// writes them ("\ud83d"), where encoding/json would write U+FFFD.
type Text string

// MarshalJSON writes the string, each lone surrogate as its \u escape.
func (t Text) MarshalJSON() ([]byte, error) {
	s := string(t)
	var out bytes.Buffer
	out.WriteByte('"')
	start := 0
	for i := 0; i < len(s); i++ {
		r, ok := surrogateAt(s, i)
		if !ok {
			continue
		}
		if err := appendJSON(&out, s[start:i]); err != nil {
			return nil, err
		}
		fmt.Fprintf(&out, `\u%04x`, r)
		i += 2
		start = i + 1
	}
	if err := appendJSON(&out, s[start:]); err != nil {
		return nil, err
	}
	out.WriteByte('"')
	return out.Bytes(), nil
}

func appendJSON(out *bytes.Buffer, s string) error {
	part, err := json.Marshal(s)
	if err != nil {
		return err
	}
	out.Write(part[1 : len(part)-1])
	return nil
}

// NumberText is String(number).
func NumberText(f float64) string { return jsNumber(f) }

// Len16 is s.length (UTF-16 code units).
func Len16(s string) int { return len16(s) }

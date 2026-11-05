package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	situations "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// The pseudonymiser indexes text the way JavaScript does: by UTF-16 code unit. Name lengths, the
// 80-unit window around a truncation mark and the word check next to a match all depend on it, so
// the text is held as units and never by byte or rune.
//
// A title cut inside an emoji or a letter outside the Basic Multilingual Plane reaches this package
// with half a surrogate pair, held in WTF-8 (situations.Text16). It is half of a name too, so it
// must survive as a unit: Go's string conversions would turn it into U+FFFD and the name would no
// longer be found.

// surrogateAt is the WTF-8 surrogate at s[i:], if there is one.
func surrogateAt(s string, i int) (uint16, bool) {
	if i+2 < len(s) && s[i] == 0xed && s[i+1] >= 0xa0 && s[i+1] <= 0xbf && s[i+2] >= 0x80 && s[i+2] <= 0xbf {
		return 0xd000 | uint16(s[i+1]&0x3f)<<6 | uint16(s[i+2]&0x3f), true
	}
	return 0, false
}

// toUnits is the string as JavaScript holds it.
func toUnits(s string) []uint16 {
	units := make([]uint16, 0, len(s))
	for i := 0; i < len(s); {
		if unit, ok := surrogateAt(s, i); ok {
			units = append(units, unit)
			i += 3
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		units = utf16.AppendRune(units, r)
		i += size
	}
	return units
}

// fromUnits is the string the units spell, a lone surrogate in WTF-8.
func fromUnits(units []uint16) string {
	var out strings.Builder
	out.Grow(len(units))
	for i := 0; i < len(units); i++ {
		r := rune(units[i])
		if utf16.IsSurrogate(r) {
			if i+1 < len(units) {
				if pair := utf16.DecodeRune(r, rune(units[i+1])); pair != unicode.ReplacementChar {
					out.WriteRune(pair)
					i++
					continue
				}
			}
			out.Write([]byte{0xed, byte(0xa0 | (r>>6)&0x1f), byte(0x80 | r&0x3f)}) //nolint:gosec // masked
			continue
		}
		out.WriteRune(r)
	}
	return out.String()
}

// WellFormed is s as JavaScript writes it to UTF-8, for a hash or the database: a lone surrogate
// becomes U+FFFD.
func WellFormed(s string) string { return string(utf16.Decode(toUnits(s))) }

// Slice16 is s.slice(0, n) by UTF-16 code units.
func Slice16(s string, n int) string {
	units := toUnits(s)
	if len(units) <= n {
		return s
	}
	return fromUnits(units[:n])
}

// CodePoints is Array.from(s).length.
func CodePoints(s string) int {
	units := toUnits(s)
	points := len(units)
	for i := 0; i+1 < len(units); i++ {
		if utf16.DecodeRune(rune(units[i]), rune(units[i+1])) != unicode.ReplacementChar {
			points--
			i++
		}
	}
	return points
}

// Text is a string that may hold half a surrogate pair; it marshals as JSON.stringify writes it.
type Text string

// MarshalJSON writes the string, a lone surrogate as its \u escape.
func (t Text) MarshalJSON() ([]byte, error) {
	s := string(t)
	var out bytes.Buffer
	out.WriteByte('"')
	start := 0
	for i := 0; i < len(s); {
		unit, ok := surrogateAt(s, i)
		if !ok {
			i++
			continue
		}
		if err := writeEscaped(&out, s[start:i]); err != nil {
			return nil, err
		}
		fmt.Fprintf(&out, `\u%04x`, unit)
		i += 3
		start = i
	}
	if err := writeEscaped(&out, s[start:]); err != nil {
		return nil, err
	}
	out.WriteByte('"')
	return out.Bytes(), nil
}

// writeEscaped writes the inside of a JSON string, without the HTML escapes of encoding/json.
func writeEscaped(out *bytes.Buffer, s string) error {
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(s); err != nil {
		return err
	}
	inside := bytes.TrimRight(encoded.Bytes(), "\n")
	out.Write(inside[1 : len(inside)-1])
	return nil
}

func hasPrefixUnits(s, prefix []uint16) bool {
	if len(prefix) > len(s) {
		return false
	}
	for i, unit := range prefix {
		if s[i] != unit {
			return false
		}
	}
	return true
}

func hasSuffixUnits(s, suffix []uint16) bool {
	return len(suffix) <= len(s) && hasPrefixUnits(s[len(s)-len(suffix):], suffix)
}

// indexUnits is s.indexOf(sub, from).
func indexUnits(s, sub []uint16, from int) int {
	for at := from; at+len(sub) <= len(s); at++ {
		if s[at] == sub[0] && hasPrefixUnits(s[at:], sub) {
			return at
		}
	}
	return -1
}

func isSpaceUnit(unit uint16) bool { return situations.IsJSSpace(rune(unit)) }

// trimLeftUnits is String.prototype.trimStart.
func trimLeftUnits(s []uint16) []uint16 {
	for len(s) > 0 && isSpaceUnit(s[0]) {
		s = s[1:]
	}
	return s
}

// trimRightUnits is String.prototype.trimEnd.
func trimRightUnits(s []uint16) []uint16 {
	for len(s) > 0 && isSpaceUnit(s[len(s)-1]) {
		s = s[:len(s)-1]
	}
	return s
}

// isWord is /[\p{L}\p{N}]/u on one code point.
func isWord(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) }

// isWordAt is isWordAt of pseudonyms.ts: it reads one UTF-16 unit, so half of a surrogate pair is
// never a word character, not even in a letter outside the Basic Multilingual Plane.
func isWordAt(text []uint16, position int) bool {
	return position >= 0 && position < len(text) && isWord(rune(text[position]))
}

package domain

import (
	"encoding/json"
	"fmt"
	"unicode/utf16"
	"unicode/utf8"

	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// Units is a JavaScript string: UTF-16 code units, so slices, lengths and indexOf count what
// String.prototype counts, and a slice may leave a lone surrogate.
type Units []uint16

// UnitsOf is the JavaScript string of s.
func UnitsOf(s string) Units { return utf16.Encode([]rune(s)) }

// Slice is String.prototype.slice(start, end) with non-negative bounds.
func (u Units) Slice(start, end int) Units {
	end = min(end, len(u))
	if start >= end {
		return Units{}
	}
	return u[start:end]
}

// Trim is String.prototype.trim.
func (u Units) Trim() Units {
	start, end := 0, len(u)
	for start < end && js.IsJSSpace(rune(u[start])) {
		start++
	}
	for end > start && js.IsJSSpace(rune(u[end-1])) {
		end--
	}
	return u[start:end]
}

// Index is String.prototype.indexOf(needle), -1 when absent.
func (u Units) Index(needle Units) int {
	for i := 0; i+len(needle) <= len(u); i++ {
		match := true
		for j, c := range needle {
			if u[i+j] != c {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

// String is the string as a database driver sends it: a lone surrogate becomes U+FFFD, as
// Buffer.from(s, 'utf8') writes it.
func (u Units) String() string { return string(utf16.Decode(u)) }

// Text keeps lone surrogates, for a JSON answer.
func (u Units) Text() Text {
	b := make([]byte, 0, len(u))
	for i := 0; i < len(u); i++ {
		c := rune(u[i])
		if utf16.IsSurrogate(c) && c < 0xdc00 && i+1 < len(u) && u[i+1] >= 0xdc00 && u[i+1] <= 0xdfff {
			b = utf8.AppendRune(b, utf16.DecodeRune(c, rune(u[i+1])))
			i++
			continue
		}
		if utf16.IsSurrogate(c) {
			// WTF-8: the three bytes UTF-8 would give the code point, which it forbids.
			b = append(b, 0xed, byte(0x80|(c>>6)&0x3f), byte(0x80|c&0x3f)) //nolint:gosec // masked
			continue
		}
		b = utf8.AppendRune(b, c)
	}
	return Text(b)
}

// Text is a string that may hold lone UTF-16 surrogates (in WTF-8, ED A0–BF xx), as a
// JavaScript slice can leave one; it marshals as JSON.stringify writes it ("\ud83d").
type Text string

// MarshalJSON writes the string, with each WTF-8 surrogate as its \u escape.
func (t Text) MarshalJSON() ([]byte, error) {
	s := string(t)
	out := []byte{'"'}
	start := 0
	for i := 0; i+2 < len(s); i++ {
		if s[i] != 0xed || s[i+1] < 0xa0 || s[i+1] > 0xbf || s[i+2] < 0x80 || s[i+2] > 0xbf {
			continue
		}
		part, err := json.Marshal(s[start:i])
		if err != nil {
			return nil, err
		}
		out = append(out, part[1:len(part)-1]...)
		out = fmt.Appendf(out, `\u%04x`, 0xd000|rune(s[i+1]&0x3f)<<6|rune(s[i+2]&0x3f))
		i += 2
		start = i + 1
	}
	part, err := json.Marshal(s[start:])
	if err != nil {
		return nil, err
	}
	return append(append(out, part[1:len(part)-1]...), '"'), nil
}

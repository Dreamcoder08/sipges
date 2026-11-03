package domain

import (
	"encoding/json"
	"fmt"
	"unicode/utf16"
)

// Text16 is a string that may end in a lone UTF-16 high surrogate, as a JavaScript slice can
// leave one: the surrogate is held in WTF-8 (ED A0–AF xx) and marshals as JSON.stringify writes
// it, "\ud83d", where encoding/json would write U+FFFD.
type Text16 string

// Slice16 is s.slice(0, n) by UTF-16 code units.
func Slice16(s string, n int) Text16 {
	units := 0
	for i, r := range s {
		size := utf16.RuneLen(r)
		if units+size > n {
			if size == 2 && units+1 == n {
				hi, _ := utf16.EncodeRune(r)
				// A high surrogate is 0xD800–0xDBFF: both masked values fit in a byte.
				return Text16(s[:i] + string([]byte{0xed, byte(0xa0 | (hi>>6)&0x0f), byte(0x80 | hi&0x3f)})) //nolint:gosec // masked above
			}
			return Text16(s[:i])
		}
		units += size
	}
	return Text16(s)
}

// MarshalJSON writes the string, with each WTF-8 surrogate as its \u escape.
func (t Text16) MarshalJSON() ([]byte, error) {
	s := string(t)
	out := []byte{'"'}
	start := 0
	for i := 0; i+2 < len(s); i++ {
		if s[i] != 0xed || s[i+1] < 0xa0 || s[i+1] > 0xaf || s[i+2] < 0x80 || s[i+2] > 0xbf {
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

package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
	"strings"
)

// Number is a float64 that encodes as JSON.stringify does: NaN and ±Infinity as null, -0 as 0.
type Number float64

// MarshalJSON implements json.Marshaler.
func (n Number) MarshalJSON() ([]byte, error) {
	f := float64(n)
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return []byte("null"), nil
	}
	return []byte(FormatNumber(f)), nil
}

// FormatNumber is JavaScript's String(number).
func FormatNumber(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0" // also -0
	}
	format := byte('f')
	if abs := math.Abs(f); abs < 1e-6 || abs >= 1e21 {
		format = 'e'
	}
	b := strconv.AppendFloat(nil, f, format, -1, 64)
	if format == 'e' {
		// Go writes e-07 where JavaScript writes e-7.
		if n := len(b); n >= 4 && b[n-4] == 'e' && b[n-3] == '-' && b[n-2] == '0' {
			b[n-2] = b[n-1]
			b = b[:n-1]
		}
	}
	return string(b)
}

// Round is Math.round: halves round towards +Infinity.
func Round(f float64) float64 {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return f
	}
	r := math.Floor(f)
	if f-r >= 0.5 {
		r++
	}
	return r
}

// isJSSpace reports the WhiteSpace and LineTerminator code points String.prototype.trim and
// Number() strip; unlike unicode.IsSpace it includes U+FEFF and excludes U+0085.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// Trim is String.prototype.trim.
func Trim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// UTF16Len is a JavaScript string's length.
func UTF16Len(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xffff {
			n++
		}
	}
	return n
}

// SliceUTF16 is s.slice(0, n) in UTF-16 code units. A surrogate pair the cut would split is
// dropped whole: a Go string cannot carry the lone surrogate JavaScript would keep.
func SliceUTF16(s string, n int) string {
	units := 0
	for i, r := range s {
		width := 1
		if r > 0xffff {
			width = 2
		}
		if units+width > n {
			return s[:i]
		}
		units += width
	}
	return s
}

// Truthy is JavaScript truthiness for values decoded by DecodeJSON.
func Truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0 && !math.IsNaN(x)
	default:
		return true
	}
}

// ErrTooDeep marks JSON nested beyond encoding/json's limit, which JSON.parse still reads.
var ErrTooDeep = errors.New("geography: JSON nested too deeply")

// DecodeJSON is JSON.parse of a UTF-8 text decoded as Response.text() decodes it (a leading byte
// order mark dropped): objects as map[string]any (the last duplicate wins), numbers as float64
// with out-of-range values as ±Infinity or 0, and an error for anything JSON.parse rejects.
func DecodeJSON(body []byte) (any, error) {
	body = bytes.TrimPrefix(body, []byte("\xef\xbb\xbf"))
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		if strings.Contains(err.Error(), "exceeded max depth") {
			return nil, ErrTooDeep
		}
		return nil, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("geography: trailing data after JSON")
	}
	return normalize(v), nil
}

func normalize(v any) any {
	switch x := v.(type) {
	case json.Number:
		f, _ := strconv.ParseFloat(string(x), 64) // out of range gives ±Inf or 0, as JSON.parse
		return f
	case []any:
		for i := range x {
			x[i] = normalize(x[i])
		}
		return x
	case map[string]any:
		for k, e := range x {
			x[k] = normalize(e)
		}
		return x
	}
	return v
}

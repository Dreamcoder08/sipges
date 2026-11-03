package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
)

// The value semantics of python.ts as the dashboard needs them, on a raw JSON value as stored. A
// nil value is JavaScript's undefined (an absent key); the JSON literal null is null.

// PyStr is pyStr: Python `str()` of a JSON value as the TypeScript API computes it (String(n)
// for numbers, JSON.stringify for arrays and objects).
func PyStr(v json.RawMessage) (string, error) {
	v = bytes.TrimSpace(v)
	if len(v) == 0 {
		return "", nil
	}
	switch v[0] {
	case 'n':
		return "None", nil
	case 't':
		return "True", nil
	case 'f':
		return "False", nil
	case '"':
		var s string
		err := json.Unmarshal(v, &s)
		return s, err
	case '[', '{':
		var b strings.Builder
		dec := json.NewDecoder(bytes.NewReader(v))
		dec.UseNumber()
		err := stringify(&b, dec)
		return b.String(), err
	default:
		return jsNumber(string(v))
	}
}

// PyTruthy is pyTruthy: false for undefined, null, false, 0, "" and empty arrays and objects.
func PyTruthy(v json.RawMessage) (bool, error) {
	v = bytes.TrimSpace(v)
	if len(v) == 0 {
		return false, nil
	}
	switch v[0] {
	case 'n', 'f':
		return false, nil
	case 't':
		return true, nil
	case '"':
		return !bytes.Equal(v, []byte(`""`)), nil
	case '[':
		var items []json.RawMessage
		err := json.Unmarshal(v, &items)
		return len(items) > 0, err
	case '{':
		var fields map[string]json.RawMessage
		err := json.Unmarshal(v, &fields)
		return len(fields) > 0, err
	default:
		f, err := parseNumber(string(v))
		return f != 0, err
	}
}

// jsWhitespace is what String.prototype.trim removes: WhiteSpace and LineTerminator of
// ECMAScript (it includes U+FEFF and excludes U+0085, unlike unicode.IsSpace).
const jsWhitespace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

// JSTrim is String.prototype.trim.
func JSTrim(s string) string { return strings.Trim(s, jsWhitespace) }

func parseNumber(s string) (float64, error) {
	f, err := strconv.ParseFloat(s, 64)
	// Out of range is ±Infinity in JSON.parse too, and underflow is 0; only syntax fails.
	if numErr := (*strconv.NumError)(nil); err != nil && (!errors.As(err, &numErr) || !errors.Is(numErr.Err, strconv.ErrRange)) {
		return 0, fmt.Errorf("analytics: invalid JSON number %q: %w", s, err)
	}
	return f, nil
}

// jsNumber is String(number) of the value JSON.parse gives the JSON number s.
func jsNumber(s string) (string, error) {
	f, err := parseNumber(s)
	if err != nil {
		return "", err
	}
	switch {
	case math.IsInf(f, 1):
		return "Infinity", nil
	case math.IsInf(f, -1):
		return "-Infinity", nil
	case f == 0:
		return "0", nil // also -0
	}
	if abs := math.Abs(f); abs >= 1e21 || abs < 1e-6 {
		// ECMAScript exponent form: shortest digits, "e+21" / "e-7" without padding.
		out := strconv.FormatFloat(f, 'e', -1, 64)
		mantissa, exp, _ := strings.Cut(out, "e")
		sign, digits := exp[:1], strings.TrimLeft(exp[1:], "0")
		return mantissa + "e" + sign + digits, nil
	}
	return strconv.FormatFloat(f, 'f', -1, 64), nil
}

// stringify writes JSON.stringify of the JSON.parse of the next value of dec.
func stringify(b *strings.Builder, dec *json.Decoder) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	switch t := tok.(type) {
	case json.Delim:
		if t == '[' {
			b.WriteByte('[')
			for i := 0; dec.More(); i++ {
				if i > 0 {
					b.WriteByte(',')
				}
				if err := stringify(b, dec); err != nil {
					return err
				}
			}
			b.WriteByte(']')
		} else {
			var keys []string
			values := map[string]string{}
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return err
				}
				key, _ := keyTok.(string)
				var value strings.Builder
				if err := stringify(&value, dec); err != nil {
					return err
				}
				// A duplicate key keeps its first position and its last value.
				if _, seen := values[key]; !seen {
					keys = append(keys, key)
				}
				values[key] = value.String()
			}
			b.WriteByte('{')
			for i, key := range jsKeyOrder(keys) {
				if i > 0 {
					b.WriteByte(',')
				}
				b.WriteString(jsQuote(key))
				b.WriteByte(':')
				b.WriteString(values[key])
			}
			b.WriteByte('}')
		}
		_, err = dec.Token() // the closing delimiter
		return err
	case string:
		b.WriteString(jsQuote(t))
	case json.Number:
		n, err := jsNumber(t.String())
		if err != nil {
			return err
		}
		if strings.Contains(n, "Infinity") {
			n = "null" // JSON.stringify(Infinity)
		}
		b.WriteString(n)
	case bool:
		b.WriteString(strconv.FormatBool(t))
	case nil:
		b.WriteString("null")
	}
	return nil
}

// jsQuote is JSON.stringify of a string: only '"', '\\' and control characters are escaped.
func jsQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// arrayIndex reports whether key is an ECMAScript array index ("0" … "4294967294").
func arrayIndex(key string) (uint64, bool) {
	if key == "" || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(key, 10, 64)
	return n, err == nil && n < math.MaxUint32
}

// jsKeyOrder is the property order of a JavaScript object built in insertion order: array-index
// keys first, ascending, then the others as inserted.
func jsKeyOrder(keys []string) []string {
	var index, other []string
	for _, k := range keys {
		if _, ok := arrayIndex(k); ok {
			index = append(index, k)
		} else {
			other = append(other, k)
		}
	}
	slices.SortStableFunc(index, func(a, b string) int {
		x, _ := arrayIndex(a)
		y, _ := arrayIndex(b)
		switch {
		case x < y:
			return -1
		case x > y:
			return 1
		}
		return 0
	})
	return append(index, other...)
}

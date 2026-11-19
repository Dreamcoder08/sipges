// Package domain holds the pure rules of apps/api/src/contexts/records/domain that the read
// routes use: the module slugs, the Registros «Todos» columns and the field-level history diff.
// Stored payloads are read the way JavaScript reads the JSON.parse value postgres.js gives the
// TypeScript API, so both APIs answer the same bytes.
package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"math"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// A decoded JSON value is nil, bool, float64 (±Inf for numbers past float64, as JSON.parse
// reads 1e400), string, []any or *Object.

// Object is a JSON object with the key order JSON.parse gives it: array-index keys ("0" to
// "4294967294", canonical) ascending, then every other key in source order.
//
// Keys and values are parallel slices: most objects are record payloads of a few dozen keys at
// most, read once and written once, where a map per object cost more than the scan. Past
// linearKeys an index map finds the key instead.
type Object struct {
	keys   []string
	values []any // values[i] belongs to keys[i]
	index  map[string]int
}

// linearKeys is the most keys Get scans before Object keeps an index.
const linearKeys = 16

// NewObject returns an empty object.
func NewObject() *Object { return &Object{} }

// Keys returns the keys in JavaScript property order.
func (o *Object) Keys() []string { return o.keys }

// find returns the position of key, or -1.
func (o *Object) find(key string) int {
	if o.index != nil {
		if i, ok := o.index[key]; ok {
			return i
		}
		return -1
	}
	for i, k := range o.keys {
		if k == key {
			return i
		}
	}
	return -1
}

// Get returns an own property.
func (o *Object) Get(key string) (any, bool) {
	if i := o.find(key); i >= 0 {
		return o.values[i], true
	}
	return nil, false
}

// Set is ordinary property assignment: a new key takes its place in the property order, an
// existing one keeps its place and gets the new value (as `{...payload, _id}` does).
func (o *Object) Set(key string, v any) {
	if i := o.find(key); i >= 0 {
		o.values[i] = v
		return
	}
	index, isIndex := arrayIndex(key)
	if !isIndex {
		o.keys = append(o.keys, key)
		o.values = append(o.values, v)
		if o.index != nil {
			o.index[key] = len(o.keys) - 1
		} else if len(o.keys) > linearKeys {
			o.reindex()
		}
		return
	}
	at, _ := slices.BinarySearchFunc(o.keys, index, func(k string, target uint64) int {
		n, kIsIndex := arrayIndex(k)
		if !kIsIndex || n > target {
			return 1
		}
		if n < target {
			return -1
		}
		return 0
	})
	o.keys = slices.Insert(o.keys, at, key)
	o.values = slices.Insert(o.values, at, v)
	if o.index != nil || len(o.keys) > linearKeys {
		o.reindex() // the keys after at moved
	}
}

// reindex builds the index of every key's position.
func (o *Object) reindex() {
	o.index = make(map[string]int, len(o.keys))
	for i, k := range o.keys {
		o.index[k] = i
	}
}

// Clone is `{ ...o }`.
func (o *Object) Clone() *Object {
	c := &Object{keys: slices.Clone(o.keys), values: slices.Clone(o.values)}
	if o.index != nil {
		c.index = maps.Clone(o.index)
	}
	return c
}

// arrayIndex reports whether key is a canonical array index (ECMA-262: an integer below 2³²−1
// whose decimal spelling is the key).
func arrayIndex(key string) (uint64, bool) {
	if key == "" || len(key) > 10 || key[0] < '0' || key[0] > '9' || (key[0] == '0' && key != "0") {
		return 0, false // most keys stop here, before ParseUint allocates its error
	}
	n, err := strconv.ParseUint(key, 10, 64)
	if err != nil || n >= math.MaxUint32 {
		return 0, false
	}
	return n, true
}

// ErrNotObject is returned by ParseObject for JSON that is not an object.
var ErrNotObject = errors.New("records: payload is not a JSON object")

// Parse is JSON.parse for JSON text PostgreSQL produced.
func Parse(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := parseValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("records: trailing data after JSON value")
	}
	return v, nil
}

// ParseObject is Parse for a payload, which the schema keeps an object.
func ParseObject(data []byte) (*Object, error) {
	v, err := Parse(data)
	if err != nil {
		return nil, err
	}
	o, ok := v.(*Object)
	if !ok {
		return nil, ErrNotObject
	}
	return o, nil
}

func parseValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			o := NewObject()
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, _ := keyTok.(string)
				v, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				o.Set(key, v)
			}
			_, err = dec.Token()
			return o, err
		case '[':
			list := []any{}
			for dec.More() {
				v, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				list = append(list, v)
			}
			_, err = dec.Token()
			return list, err
		}
		return nil, fmt.Errorf("records: unexpected %v", t)
	case json.Number:
		f, err := strconv.ParseFloat(string(t), 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return nil, err
		}
		return f, nil // out of range: ±Inf or ±0, as JSON.parse rounds
	default:
		return t, nil // nil, bool, string
	}
}

// Stringify is JSON.stringify(v). ±Inf is written as null.
func Stringify(v any) []byte { return appendJSON(nil, v) }

func appendJSON(b []byte, v any) []byte {
	switch x := v.(type) {
	case nil:
		return append(b, "null"...)
	case bool:
		return strconv.AppendBool(b, x)
	case float64:
		if math.IsInf(x, 0) || math.IsNaN(x) {
			return append(b, "null"...)
		}
		return append(b, NumberString(x)...)
	case string:
		return appendString(b, x)
	case []any:
		b = append(b, '[')
		for i, item := range x {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendJSON(b, item)
		}
		return append(b, ']')
	case *Object:
		b = append(b, '{')
		for i, k := range x.keys {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendString(b, k)
			b = append(b, ':')
			b = appendJSON(b, x.values[i])
		}
		return append(b, '}')
	}
	panic(fmt.Sprintf("records: no JSON form for %T", v))
}

// appendString is JSON.stringify for a string: only '"', '\\', control characters and lone
// surrogates (held as WTF-8, see body.go) escape.
func appendString(b []byte, s string) []byte {
	if plainString(s) {
		b = append(b, '"')
		b = append(b, s...)
		return append(b, '"')
	}
	b = append(b, '"')
	for i, r := range s {
		if r == utf8.RuneError {
			if u, ok := surrogateAt(s, i); ok {
				b = fmt.Appendf(b, `\u%04x`, u)
				continue
			}
			if i > 0 {
				if _, ok := surrogateAt(s, i-1); ok {
					continue // the second byte of a surrogate written above
				}
				if i > 1 {
					if _, ok := surrogateAt(s, i-2); ok {
						continue // its third byte
					}
				}
			}
		}
		switch r {
		case '"':
			b = append(b, `\"`...)
		case '\\':
			b = append(b, `\\`...)
		case '\b':
			b = append(b, `\b`...)
		case '\f':
			b = append(b, `\f`...)
		case '\n':
			b = append(b, `\n`...)
		case '\r':
			b = append(b, `\r`...)
		case '\t':
			b = append(b, `\t`...)
		default:
			if r < 0x20 {
				b = fmt.Appendf(b, `\u%04x`, r)
			} else {
				b = append(b, string(r)...)
			}
		}
	}
	return append(b, '"')
}

// plainString reports whether JSON.stringify writes s as it is: valid UTF-8 (so no WTF-8
// surrogate) without '"', '\\' or a control character.
func plainString(s string) bool {
	ascii := true
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c < 0x20 || c == '"' || c == '\\':
			return false
		case c >= 0x80:
			ascii = false
		}
	}
	return ascii || utf8.ValidString(s)
}

// NumberString is Number.prototype.toString.
func NumberString(f float64) string {
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

// isJSSpace is JavaScript's WhiteSpace and LineTerminator set (String.prototype.trim).
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// trimJS is String.prototype.trim.
func trimJS(s string) string { return strings.TrimFunc(s, isJSSpace) }

// Len16 is a string's JavaScript length (UTF-16 code units).
func Len16(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// less16 is the default Array.prototype.sort order: UTF-16 code units.
func less16(a, b string) int {
	return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
}

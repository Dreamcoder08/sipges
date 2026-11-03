package domain

import (
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
)

// A record payload as JSON.parse returns it in the TypeScript API, so the `truthy` and `str`
// helpers of overview.ts can be ported exactly: object key order is kept (JSON.stringify
// writes it back), numbers are float64 (1e400 is Infinity), strings, booleans and nil.

// Object is a JSON object with its keys in JSON.parse insertion order.
type Object struct {
	keys   []string
	values map[string]any
}

// Get returns the value of key and whether the key is present (Object.hasOwn).
func (o *Object) Get(key string) (any, bool) {
	if o == nil {
		return nil, false
	}
	v, ok := o.values[key]
	return v, ok
}

// Payload is a record payload: always a JSON object (module_records.payload's CHECK).
type Payload = *Object

// ParsePayload decodes a module_records payload; anything but one JSON object is an error.
func ParsePayload(raw []byte) (Payload, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err == nil {
		return nil, errors.New("payload: trailing data")
	}
	o, ok := v.(*Object)
	if !ok {
		return nil, errors.New("payload: not a JSON object")
	}
	return o, nil
}

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		if t == '[' {
			list := []any{}
			for dec.More() {
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				list = append(list, v)
			}
			_, err := dec.Token()
			return list, err
		}
		o := &Object{values: map[string]any{}}
		for dec.More() {
			kt, err := dec.Token()
			if err != nil {
				return nil, err
			}
			key, _ := kt.(string)
			v, err := decodeValue(dec)
			if err != nil {
				return nil, err
			}
			if _, dup := o.values[key]; !dup { // JSON.parse: the last value, at the first position
				o.keys = append(o.keys, key)
			}
			o.values[key] = v
		}
		_, err := dec.Token()
		return o, err
	case json.Number:
		f, _ := strconv.ParseFloat(string(t), 64) // out of range is ±Inf, as JSON.parse
		return f, nil
	default:
		return t, nil // string, bool or nil
	}
}

// truthy is overview.ts `truthy`: false for undefined, null, false, 0, "", [] and {}.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		return x != ""
	case []any:
		return len(x) > 0
	case *Object:
		return len(x.keys) > 0
	}
	return true
}

// str is overview.ts `str`: strings as they are, numbers as String(n), anything else as
// JSON.stringify.
func str(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return jsNumber(x)
	}
	var b strings.Builder
	stringify(&b, v)
	return b.String()
}

// jsNumber is JavaScript's Number.prototype.toString(): the shortest round-trip digits, fixed
// notation from 1e-6 up to 1e21, exponential (`1e+21`, `1.5e-7`) outside it.
func jsNumber(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	sign := ""
	if f < 0 {
		sign, f = "-", -f
	}
	mantissa, exp, _ := strings.Cut(strconv.FormatFloat(f, 'e', -1, 64), "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	e, _ := strconv.Atoi(exp)
	k, n := len(digits), e+1
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	out := sign + digits[:1]
	if k > 1 {
		out += "." + digits[1:]
	}
	if n-1 >= 0 {
		return out + "e+" + strconv.Itoa(n-1)
	}
	return out + "e-" + strconv.Itoa(1-n)
}

// arrayIndex reports whether key is a canonical array index, which JavaScript objects list
// before every other key, in ascending numeric order.
func arrayIndex(key string) (uint64, bool) {
	if key == "" || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(key, 10, 64)
	return n, err == nil && n < math.MaxUint32
}

// stringify writes v as JSON.stringify does.
func stringify(b *strings.Builder, v any) {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(x))
	case float64:
		if math.IsInf(x, 0) || math.IsNaN(x) {
			b.WriteString("null")
		} else {
			b.WriteString(jsNumber(x))
		}
	case string:
		quote(b, x)
	case []any:
		b.WriteByte('[')
		for i, item := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			stringify(b, item)
		}
		b.WriteByte(']')
	case *Object:
		var indexes, others []string
		for _, k := range x.keys {
			if _, ok := arrayIndex(k); ok {
				indexes = append(indexes, k)
			} else {
				others = append(others, k)
			}
		}
		slices.SortFunc(indexes, func(a, c string) int {
			an, _ := arrayIndex(a)
			cn, _ := arrayIndex(c)
			return cmp.Compare(an, cn)
		})
		b.WriteByte('{')
		for i, k := range append(indexes, others...) {
			if i > 0 {
				b.WriteByte(',')
			}
			quote(b, k)
			b.WriteByte(':')
			stringify(b, x.values[k])
		}
		b.WriteByte('}')
	}
}

// quote is JSON.stringify's string quoting: only `"`, `\` and control characters are escaped.
func quote(b *strings.Builder, s string) {
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
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

package infrastructure

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/domain"
)

// object is a JSON object as JSON.parse builds it, so official attributes pass through as the
// TypeScript API answers them: keys keep their first position (the last duplicate's value
// wins), and JSON.stringify writes array-index keys first, ascending.
type object struct {
	keys []string
	vals map[string]any
}

func (o *object) get(key string) any {
	if o == nil {
		return nil
	}
	return o.vals[key]
}

func (o *object) set(key string, v any) {
	if _, seen := o.vals[key]; !seen {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = v
}

// maxDepth bounds nesting; a deeper official answer is refused as unreadable.
const maxDepth = 10_000

var errUnreadable = errors.New("geography: unreadable official JSON")

// parseOrdered is JSON.parse of an official answer: objects as *object, arrays as []any,
// numbers as float64 (±Inf out of range), strings, booleans and nil.
func parseOrdered(body []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(bytes.TrimPrefix(body, []byte("\xef\xbb\xbf"))))
	dec.UseNumber()
	v, err := readValue(dec, 0)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errUnreadable
	}
	return v, nil
}

func readValue(dec *json.Decoder, depth int) (any, error) {
	if depth > maxDepth {
		return nil, errUnreadable
	}
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			o := &object{vals: map[string]any{}}
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, _ := keyTok.(string)
				v, err := readValue(dec, depth+1)
				if err != nil {
					return nil, err
				}
				o.set(key, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return o, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := readValue(dec, depth+1)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
		return nil, errUnreadable
	case json.Number:
		f, _ := strconv.ParseFloat(string(t), 64)
		return f, nil
	default:
		return t, nil // string, bool or nil
	}
}

// isArrayIndex reports a canonical uint32 array index other than 2^32-1.
func isArrayIndex(key string) bool {
	if key == "" || (len(key) > 1 && key[0] == '0') {
		return false
	}
	n, err := strconv.ParseUint(key, 10, 32)
	return err == nil && n < 1<<32-1
}

// stringify is JSON.stringify of a value read by parseOrdered.
func stringify(buf *bytes.Buffer, v any) {
	switch x := v.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		buf.WriteString(strconv.FormatBool(x))
	case float64:
		b, _ := domain.Number(x).MarshalJSON()
		buf.Write(b)
	case string:
		quote(buf, x)
	case []any:
		buf.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				buf.WriteByte(',')
			}
			stringify(buf, e)
		}
		buf.WriteByte(']')
	case *object:
		var indices, named []string
		for _, k := range x.keys {
			if isArrayIndex(k) {
				indices = append(indices, k)
			} else {
				named = append(named, k)
			}
		}
		slices.SortFunc(indices, func(a, b string) int {
			if len(a) != len(b) {
				return len(a) - len(b)
			}
			return strings.Compare(a, b)
		})
		buf.WriteByte('{')
		for i, k := range append(indices, named...) {
			if i > 0 {
				buf.WriteByte(',')
			}
			quote(buf, k)
			buf.WriteByte(':')
			stringify(buf, x.vals[k])
		}
		buf.WriteByte('}')
	}
}

// quote writes s as JSON.stringify quotes a string (no HTML or U+2028 escaping).
func quote(buf *bytes.Buffer, s string) {
	const hex = "0123456789abcdef"
	buf.WriteByte('"')
	for i := 0; i < len(s); {
		c := s[i]
		if c >= utf8.RuneSelf {
			r, size := utf8.DecodeRuneInString(s[i:])
			buf.WriteRune(r) // invalid bytes become U+FFFD, as the decoder already read them
			i += size
			continue
		}
		switch c {
		case '"':
			buf.WriteString(`\"`)
		case '\\':
			buf.WriteString(`\\`)
		case '\b':
			buf.WriteString(`\b`)
		case '\f':
			buf.WriteString(`\f`)
		case '\n':
			buf.WriteString(`\n`)
		case '\r':
			buf.WriteString(`\r`)
		case '\t':
			buf.WriteString(`\t`)
		default:
			if c < 0x20 {
				buf.WriteString(`\u00`)
				buf.WriteByte(hex[c>>4])
				buf.WriteByte(hex[c&0xf])
			} else {
				buf.WriteByte(c)
			}
		}
		i++
	}
	buf.WriteByte('"')
}

// stringified is v as JSON.stringify writes it.
func stringified(v any) json.RawMessage {
	var buf bytes.Buffer
	stringify(&buf, v)
	return buf.Bytes()
}

// jsString is String(v) for a value read by parseOrdered.
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return domain.FormatNumber(x)
	case string:
		return x
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

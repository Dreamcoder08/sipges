package desktoprelease

// JavaScript semantics the Node updater relies on, reproduced so Go accepts and refuses the same
// manifests: JSON.parse objects (key order, duplicate keys), String.prototype.trim, string length
// and ordering in UTF-16 code units, toLowerCase and JSON.stringify of a string.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

// jsObject is a parsed JSON object (or an array seen as one, as Object.keys sees it): keys in
// JavaScript property order, each with its last value.
type jsObject struct {
	keys   []string
	values map[string]json.RawMessage
}

func (o *jsObject) get(key string) (json.RawMessage, bool) {
	v, ok := o.values[key]
	return v, ok
}

// jsKind is the JavaScript type of a JSON value: object, array, string, number, boolean or null.
func jsKind(raw json.RawMessage) string {
	raw = bytes.TrimLeft(raw, " \t\r\n")
	if len(raw) == 0 {
		return "undefined"
	}
	switch raw[0] {
	case '{':
		return "object"
	case '[':
		return "array"
	case '"':
		return "string"
	case 't', 'f':
		return "boolean"
	case 'n':
		return "null"
	}
	return "number"
}

// jsString returns the value when raw is a JSON string.
func jsString(raw json.RawMessage) (string, bool) {
	if jsKind(raw) != "string" {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	return s, true
}

// jsNumberValue returns the value when raw is a JSON number.
func jsNumberValue(raw json.RawMessage) (float64, bool) {
	if jsKind(raw) != "number" {
		return 0, false
	}
	f, err := strconv.ParseFloat(string(bytes.TrimSpace(raw)), 64)
	return f, err == nil
}

// jsTruthy is JavaScript truthiness of a JSON value (a missing value is undefined, falsy).
func jsTruthy(raw json.RawMessage, present bool) bool {
	if !present {
		return false
	}
	switch jsKind(raw) {
	case "null":
		return false
	case "boolean":
		return bytes.HasPrefix(bytes.TrimSpace(raw), []byte("true"))
	case "number":
		f, _ := jsNumberValue(raw)
		return f != 0
	case "string":
		s, _ := jsString(raw)
		return s != ""
	}
	return true
}

// parseObject reads a JSON object, or an array as Object.keys sees it ("0", "1", ...).
func parseObject(raw json.RawMessage) (*jsObject, error) {
	obj := &jsObject{values: map[string]json.RawMessage{}}
	if jsKind(raw) == "array" {
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			return nil, err
		}
		for i, item := range items {
			key := strconv.Itoa(i)
			obj.keys = append(obj.keys, key)
			obj.values[key] = item
		}
		return obj, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, fmt.Errorf("not a JSON object")
	}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, ok := tok.(string)
		if !ok {
			return nil, fmt.Errorf("not a JSON object key")
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		if _, seen := obj.values[key]; !seen {
			obj.keys = append(obj.keys, key)
		}
		obj.values[key] = value
	}
	obj.keys = jsPropertyOrder(obj.keys)
	return obj, nil
}

// jsPropertyOrder puts array-index keys first in ascending order, then the others in insertion
// order, as JavaScript orders an object's own string keys.
func jsPropertyOrder(keys []string) []string {
	type index struct {
		key string
		n   uint64
	}
	var indexes []index
	var others []string
	for _, k := range keys {
		if n, err := strconv.ParseUint(k, 10, 32); err == nil && n < 1<<32-1 && strconv.FormatUint(n, 10) == k {
			indexes = append(indexes, index{k, n})
		} else {
			others = append(others, k)
		}
	}
	sort.Slice(indexes, func(i, j int) bool { return indexes[i].n < indexes[j].n })
	out := make([]string, 0, len(keys))
	for _, i := range indexes {
		out = append(out, i.key)
	}
	return append(out, others...)
}

// jsIsSpace is the set String.prototype.trim removes: WhiteSpace and LineTerminator.
func jsIsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func jsTrim(s string) string { return strings.TrimFunc(s, jsIsSpace) }

// utf16Len is a string's JavaScript length.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n += max(utf16.RuneLen(r), 1)
	}
	return n
}

// utf16Less orders strings as JavaScript's < and default sort do: by UTF-16 code units.
func utf16Less(a, b string) bool {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < min(len(ua), len(ub)); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

func sortUTF16(list []string) {
	sort.SliceStable(list, func(i, j int) bool { return utf16Less(list[i], list[j]) })
}

// jsLower is String.prototype.toLowerCase (full Unicode lower-casing, final sigma included).
func jsLower(s string) string { return cases.Lower(language.Und).String(s) }

// jsStringify is JSON.stringify of a value for a message: strings as JavaScript quotes them,
// anything else as compact JSON.
func jsStringify(raw json.RawMessage) string {
	s, ok := jsString(raw)
	if !ok {
		var out bytes.Buffer
		if json.Compact(&out, raw) != nil {
			return string(raw)
		}
		return out.String()
	}
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

// posixNormalize is Node's path.posix.normalize for a relative path: path.Clean, except that a
// trailing slash is kept.
func posixNormalize(p string) string {
	trailing := strings.HasSuffix(p, "/")
	clean := path.Clean(p)
	if trailing && clean != "/" {
		return clean + "/"
	}
	return clean
}

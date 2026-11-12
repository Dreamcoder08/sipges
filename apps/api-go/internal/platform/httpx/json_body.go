package httpx

import (
	"math"
	"strconv"
	"strings"
	"unicode/utf16"
)

// JSONKind is the type zod reports for a JSON.parse value ("received …").
type JSONKind string

// The kinds of a JSON.parse value.
const (
	JSONNull     JSONKind = "null"
	JSONBool     JSONKind = "boolean"
	JSONNumber   JSONKind = "number"
	JSONInfinity JSONKind = "Infinity"
	JSONNegInf   JSONKind = "-Infinity"
	JSONString   JSONKind = "string"
	JSONArray    JSONKind = "array"
	JSONObject   JSONKind = "object"
)

// JSONValue is a JSON.parse result as far as the request schemas read it: its kind, a string's
// text, and an object's own fields one level down.
type JSONValue struct {
	Kind   JSONKind
	Text   string
	Fields map[string]JSONValue
}

// ParseJSONBody is Hono's c.req.json(): the WHATWG decoding (dropping a byte order mark), then
// JSON.parse. ok is false where JSON.parse throws. Nesting has no limit, as in V8: nested
// values are walked with an explicit stack.
func ParseJSONBody(body []byte) (JSONValue, bool) {
	p := jsonParser{s: DecodeUTF8(body, true)}
	p.space()
	v, ok := p.value(true)
	if !ok {
		return JSONValue{}, false
	}
	p.space()
	return v, p.i == len(p.s)
}

type jsonParser struct {
	s string
	i int
}

// space skips JSON whitespace: only space, tab, line feed and carriage return.
func (p *jsonParser) space() {
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *jsonParser) peek() byte {
	if p.i < len(p.s) {
		return p.s[p.i]
	}
	return 0
}

// value reads one value. With fields, an object's members are kept (the top level); any other
// container is only checked.
func (p *jsonParser) value(fields bool) (JSONValue, bool) {
	switch c := p.peek(); {
	case c == '{' && fields:
		return p.object()
	case c == '{' || c == '[':
		kind := JSONObject
		if c == '[' {
			kind = JSONArray
		}
		return JSONValue{Kind: kind}, p.skipContainer()
	default:
		return p.scalar()
	}
}

// object reads the top-level object; a repeated key keeps its last value, as JSON.parse does.
func (p *jsonParser) object() (JSONValue, bool) {
	v := JSONValue{Kind: JSONObject, Fields: map[string]JSONValue{}}
	p.i++ // {
	p.space()
	if p.peek() == '}' {
		p.i++
		return v, true
	}
	for {
		p.space()
		if p.peek() != '"' {
			return v, false
		}
		key, ok := p.str()
		if !ok {
			return v, false
		}
		p.space()
		if p.peek() != ':' {
			return v, false
		}
		p.i++
		p.space()
		member, ok := p.value(false)
		if !ok {
			return v, false
		}
		v.Fields[key] = member
		p.space()
		switch p.peek() {
		case ',':
			p.i++
		case '}':
			p.i++
			return v, true
		default:
			return v, false
		}
	}
}

// skipContainer checks the array or object at p.i without keeping it, with a stack instead of
// recursion.
func (p *jsonParser) skipContainer() bool {
	var closers []byte
	// open consumes the container at p.i; it reports whether a value must follow.
	open := func() (bool, bool) {
		c := p.s[p.i]
		p.i++
		p.space()
		if c == '[' {
			if p.peek() == ']' {
				p.i++
				return false, true
			}
			closers = append(closers, ']')
			return true, true
		}
		if p.peek() == '}' {
			p.i++
			return false, true
		}
		closers = append(closers, '}')
		return true, p.key()
	}
	needValue, ok := open()
	for ok {
		if needValue {
			p.space()
			if c := p.peek(); c == '[' || c == '{' {
				needValue, ok = open()
				continue
			}
			if _, ok = p.scalar(); !ok {
				return false
			}
		}
		if len(closers) == 0 {
			return true
		}
		p.space()
		top := closers[len(closers)-1]
		switch p.peek() {
		case ',':
			p.i++
			needValue = true
			if top == '}' {
				p.space()
				ok = p.key()
			}
		case top:
			p.i++
			closers = closers[:len(closers)-1]
			needValue = false
		default:
			return false
		}
	}
	return false
}

// key reads `"name" :` inside a skipped object.
func (p *jsonParser) key() bool {
	if p.peek() != '"' {
		return false
	}
	if _, ok := p.str(); !ok {
		return false
	}
	p.space()
	if p.peek() != ':' {
		return false
	}
	p.i++
	return true
}

func (p *jsonParser) scalar() (JSONValue, bool) {
	switch c := p.peek(); {
	case c == '"':
		s, ok := p.str()
		return JSONValue{Kind: JSONString, Text: s}, ok
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	}
	for literal, kind := range map[string]JSONKind{"true": JSONBool, "false": JSONBool, "null": JSONNull} {
		if strings.HasPrefix(p.s[p.i:], literal) {
			p.i += len(literal)
			return JSONValue{Kind: kind}, true
		}
	}
	return JSONValue{}, false
}

// number reads the JSON number grammar; a value beyond float64 is ±Infinity, as in JavaScript.
func (p *jsonParser) number() (JSONValue, bool) {
	start := p.i
	if p.peek() == '-' {
		p.i++
	}
	switch c := p.peek(); {
	case c == '0':
		p.i++
	case c >= '1' && c <= '9':
		p.digits()
	default:
		return JSONValue{}, false
	}
	if p.peek() == '.' {
		p.i++
		if !p.digits() {
			return JSONValue{}, false
		}
	}
	if c := p.peek(); c == 'e' || c == 'E' {
		p.i++
		if c := p.peek(); c == '+' || c == '-' {
			p.i++
		}
		if !p.digits() {
			return JSONValue{}, false
		}
	}
	f, _ := strconv.ParseFloat(p.s[start:p.i], 64) // a range error still yields ±Inf or 0
	switch {
	case math.IsInf(f, 1):
		return JSONValue{Kind: JSONInfinity}, true
	case math.IsInf(f, -1):
		return JSONValue{Kind: JSONNegInf}, true
	}
	return JSONValue{Kind: JSONNumber}, true
}

func (p *jsonParser) digits() bool {
	start := p.i
	for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
		p.i++
	}
	return p.i > start
}

// str reads a JSON string. A lone surrogate escape becomes U+FFFD: the TypeScript API keeps it
// in a JavaScript string, but it reaches PostgreSQL (and every comparison that matters here)
// as the same U+FFFD the driver writes for it.
func (p *jsonParser) str() (string, bool) {
	p.i++ // "
	var out strings.Builder
	for p.i < len(p.s) {
		c := p.s[p.i]
		switch {
		case c == '"':
			p.i++
			return out.String(), true
		case c < 0x20:
			return "", false
		case c != '\\':
			out.WriteByte(c)
			p.i++
			continue
		}
		p.i++
		if p.i >= len(p.s) {
			return "", false
		}
		e := p.s[p.i]
		p.i++
		switch e {
		case '"', '\\', '/':
			out.WriteByte(e)
		case 'b':
			out.WriteByte('\b')
		case 'f':
			out.WriteByte('\f')
		case 'n':
			out.WriteByte('\n')
		case 'r':
			out.WriteByte('\r')
		case 't':
			out.WriteByte('\t')
		case 'u':
			r, ok := p.hex4()
			if !ok {
				return "", false
			}
			if utf16.IsSurrogate(r) && r < 0xDC00 && strings.HasPrefix(p.s[p.i:], `\u`) {
				save := p.i
				p.i += 2
				if low, ok := p.hex4(); ok && low >= 0xDC00 && low <= 0xDFFF {
					out.WriteRune(utf16.DecodeRune(r, low))
					continue
				}
				p.i = save
			}
			out.WriteRune(r) // a lone surrogate writes U+FFFD
		default:
			return "", false
		}
	}
	return "", false
}

func (p *jsonParser) hex4() (rune, bool) {
	if p.i+4 > len(p.s) {
		return 0, false
	}
	var r rune
	for _, c := range []byte(p.s[p.i : p.i+4]) {
		digit, ok := formHex(c)
		if !ok {
			return 0, false
		}
		r = r<<4 | rune(digit)
	}
	p.i += 4
	return r, true
}

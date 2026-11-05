package http

import (
	"math"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// decodeUTF8 is the WHATWG "UTF-8 decode" that Response.text(), json() and formData() apply:
// every maximal invalid subpart becomes one U+FFFD, and, with stripBOM, a leading byte order
// mark is dropped. Go's own decoding replaces invalid input differently, so the bytes are
// decoded here before any parsing.
func decodeUTF8(b []byte, stripBOM bool) string {
	if stripBOM && len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
		b = b[3:]
	}
	if utf8.Valid(b) {
		return string(b)
	}
	var out strings.Builder
	out.Grow(len(b))
	needed, seen := 0, 0
	var cp rune
	lower, upper := byte(0x80), byte(0xBF)
	for i := 0; i < len(b); {
		c := b[i]
		if needed == 0 {
			i++
			switch {
			case c <= 0x7F:
				out.WriteByte(c)
			case c >= 0xC2 && c <= 0xDF:
				needed, cp = 1, rune(c&0x1F)
			case c >= 0xE0 && c <= 0xEF:
				switch c {
				case 0xE0:
					lower = 0xA0
				case 0xED:
					upper = 0x9F
				}
				needed, cp = 2, rune(c&0x0F)
			case c >= 0xF0 && c <= 0xF4:
				switch c {
				case 0xF0:
					lower = 0x90
				case 0xF4:
					upper = 0x8F
				}
				needed, cp = 3, rune(c&0x07)
			default:
				out.WriteRune(utf8.RuneError)
			}
			continue
		}
		if c < lower || c > upper {
			// The byte starts again on its own; only the bytes before it are replaced.
			needed, seen, cp, lower, upper = 0, 0, 0, 0x80, 0xBF
			out.WriteRune(utf8.RuneError)
			continue
		}
		i++
		lower, upper = 0x80, 0xBF
		cp = cp<<6 | rune(c&0x3F)
		seen++
		if seen == needed {
			out.WriteRune(cp)
			needed, seen, cp = 0, 0, 0
		}
	}
	if needed != 0 {
		out.WriteRune(utf8.RuneError)
	}
	return out.String()
}

// jsKind is the type zod reports for a JSON.parse value ("received …").
type jsKind string

const (
	kindNull     jsKind = "null"
	kindBool     jsKind = "boolean"
	kindNumber   jsKind = "number"
	kindInfinity jsKind = "Infinity"
	kindNegInf   jsKind = "-Infinity"
	kindString   jsKind = "string"
	kindArray    jsKind = "array"
	kindObject   jsKind = "object"
)

// jsValue is a JSON.parse result as far as the request schemas read it: its kind, a string's
// text, and an object's own fields one level down.
type jsValue struct {
	kind   jsKind
	text   string
	fields map[string]jsValue
}

// parseJSONBody is Hono's c.req.json(): the WHATWG decoding (dropping a byte order mark), then
// JSON.parse. ok is false where JSON.parse throws. Nesting has no limit, as in V8: nested
// values are walked with an explicit stack.
func parseJSONBody(body []byte) (jsValue, bool) {
	p := jsonParser{s: decodeUTF8(body, true)}
	p.space()
	v, ok := p.value(true)
	if !ok {
		return jsValue{}, false
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
func (p *jsonParser) value(fields bool) (jsValue, bool) {
	switch c := p.peek(); {
	case c == '{' && fields:
		return p.object()
	case c == '{' || c == '[':
		kind := kindObject
		if c == '[' {
			kind = kindArray
		}
		return jsValue{kind: kind}, p.skipContainer()
	default:
		return p.scalar()
	}
}

// object reads the top-level object; a repeated key keeps its last value, as JSON.parse does.
func (p *jsonParser) object() (jsValue, bool) {
	v := jsValue{kind: kindObject, fields: map[string]jsValue{}}
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
		v.fields[key] = member
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

func (p *jsonParser) scalar() (jsValue, bool) {
	switch c := p.peek(); {
	case c == '"':
		s, ok := p.str()
		return jsValue{kind: kindString, text: s}, ok
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	}
	for literal, kind := range map[string]jsKind{"true": kindBool, "false": kindBool, "null": kindNull} {
		if strings.HasPrefix(p.s[p.i:], literal) {
			p.i += len(literal)
			return jsValue{kind: kind}, true
		}
	}
	return jsValue{}, false
}

// number reads the JSON number grammar; a value beyond float64 is ±Infinity, as in JavaScript.
func (p *jsonParser) number() (jsValue, bool) {
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
		return jsValue{}, false
	}
	if p.peek() == '.' {
		p.i++
		if !p.digits() {
			return jsValue{}, false
		}
	}
	if c := p.peek(); c == 'e' || c == 'E' {
		p.i++
		if c := p.peek(); c == '+' || c == '-' {
			p.i++
		}
		if !p.digits() {
			return jsValue{}, false
		}
	}
	f, _ := strconv.ParseFloat(p.s[start:p.i], 64) // a range error still yields ±Inf or 0
	switch {
	case math.IsInf(f, 1):
		return jsValue{kind: kindInfinity}, true
	case math.IsInf(f, -1):
		return jsValue{kind: kindNegInf}, true
	}
	return jsValue{kind: kindNumber}, true
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
		if !isHex(c) {
			return 0, false
		}
		r = r<<4 | rune(unhex(c))
	}
	p.i += 4
	return r, true
}

// len16 is a JavaScript string's length: UTF-16 code units.
func len16(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xFFFF {
			n++
		}
	}
	return n
}

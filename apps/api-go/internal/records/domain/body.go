package domain

import (
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Request bodies are read the way Hono's c.req.json() reads them: the bytes are decoded as
// UTF-8 by the WHATWG decoder (a leading BOM dropped, each maximal invalid subsequence replaced
// by one U+FFFD), then JSON.parse runs on that text. JavaScript strings may hold lone
// surrogates ("\ud800"), which Go strings cannot; this package keeps them as WTF-8 (the
// three-byte form of the surrogate code unit), so Stringify writes them back as JSON.stringify
// does and WellFormed turns them into U+FFFD as Node does when it sends a string to PostgreSQL.

// ErrJSONSyntax is JSON.parse's SyntaxError.
var ErrJSONSyntax = errors.New("records: invalid JSON text")

// DecodeUTF8 is the WHATWG "UTF-8 decode" of a request body.
func DecodeUTF8(data []byte) string {
	if len(data) >= 3 && data[0] == 0xef && data[1] == 0xbb && data[2] == 0xbf {
		data = data[3:]
	}
	if utf8.Valid(data) {
		return string(data)
	}
	var b strings.Builder
	b.Grow(len(data) + 8)
	for i := 0; i < len(data); {
		c := data[i]
		if c < 0x80 {
			b.WriteByte(c)
			i++
			continue
		}
		// The WHATWG decoder's state machine: the bytes needed and the bounds of the second byte.
		need, lower, upper := 0, byte(0x80), byte(0xbf)
		switch {
		case c >= 0xc2 && c <= 0xdf:
			need = 1
		case c >= 0xe0 && c <= 0xef:
			need = 2
			switch c {
			case 0xe0:
				lower = 0xa0
			case 0xed:
				upper = 0x9f
			}
		case c >= 0xf0 && c <= 0xf4:
			need = 3
			switch c {
			case 0xf0:
				lower = 0x90
			case 0xf4:
				upper = 0x8f
			}
		default:
			b.WriteRune(utf8.RuneError)
			i++
			continue
		}
		j := i + 1
		for k := 0; k < need; k++ {
			lo, hi := byte(0x80), byte(0xbf)
			if k == 0 {
				lo, hi = lower, upper
			}
			if j >= len(data) || data[j] < lo || data[j] > hi {
				break
			}
			j++
		}
		if j-i == need+1 {
			b.Write(data[i:j])
		} else {
			b.WriteRune(utf8.RuneError) // the maximal subpart i..j, the offending byte is read again
		}
		i = j
	}
	return b.String()
}

// ParseBody is JSON.parse(DecodeUTF8(data)).
func ParseBody(data []byte) (any, error) {
	p := parser{s: DecodeUTF8(data)}
	p.space()
	v, err := p.value()
	if err != nil {
		return nil, err
	}
	p.space()
	if p.i != len(p.s) {
		return nil, ErrJSONSyntax
	}
	return v, nil
}

type parser struct {
	s string
	i int
}

// space skips JSON whitespace (only these four, as JSON.parse).
func (p *parser) space() {
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *parser) literal(word string, v any) (any, error) {
	if !strings.HasPrefix(p.s[p.i:], word) {
		return nil, ErrJSONSyntax
	}
	p.i += len(word)
	return v, nil
}

func (p *parser) value() (any, error) {
	if p.i >= len(p.s) {
		return nil, ErrJSONSyntax
	}
	switch c := p.s[p.i]; {
	case c == '{':
		return p.object()
	case c == '[':
		return p.array()
	case c == '"':
		return p.string()
	case c == 't':
		return p.literal("true", true)
	case c == 'f':
		return p.literal("false", false)
	case c == 'n':
		return p.literal("null", nil)
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	}
	return nil, ErrJSONSyntax
}

func (p *parser) object() (any, error) {
	p.i++ // {
	o := NewObject()
	p.space()
	if p.i < len(p.s) && p.s[p.i] == '}' {
		p.i++
		return o, nil
	}
	for {
		p.space()
		if p.i >= len(p.s) || p.s[p.i] != '"' {
			return nil, ErrJSONSyntax
		}
		key, err := p.string()
		if err != nil {
			return nil, err
		}
		p.space()
		if p.i >= len(p.s) || p.s[p.i] != ':' {
			return nil, ErrJSONSyntax
		}
		p.i++
		p.space()
		v, err := p.value()
		if err != nil {
			return nil, err
		}
		o.Set(key.(string), v) // a repeated key keeps its first place and takes the last value
		p.space()
		if p.i >= len(p.s) {
			return nil, ErrJSONSyntax
		}
		switch p.s[p.i] {
		case ',':
			p.i++
		case '}':
			p.i++
			return o, nil
		default:
			return nil, ErrJSONSyntax
		}
	}
}

func (p *parser) array() (any, error) {
	p.i++ // [
	list := []any{}
	p.space()
	if p.i < len(p.s) && p.s[p.i] == ']' {
		p.i++
		return list, nil
	}
	for {
		p.space()
		v, err := p.value()
		if err != nil {
			return nil, err
		}
		list = append(list, v)
		p.space()
		if p.i >= len(p.s) {
			return nil, ErrJSONSyntax
		}
		switch p.s[p.i] {
		case ',':
			p.i++
		case ']':
			p.i++
			return list, nil
		default:
			return nil, ErrJSONSyntax
		}
	}
}

func digits(s string, i int) int {
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	return i
}

// number reads -?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)? and rounds it as JSON.parse does (to the
// nearest double; past the range, ±Infinity or ±0).
func (p *parser) number() (any, error) {
	start := p.i
	i := p.i
	if p.s[i] == '-' {
		i++
	}
	switch {
	case i < len(p.s) && p.s[i] == '0':
		i++
	case i < len(p.s) && p.s[i] >= '1' && p.s[i] <= '9':
		i = digits(p.s, i)
	default:
		return nil, ErrJSONSyntax
	}
	if i < len(p.s) && p.s[i] == '.' {
		j := digits(p.s, i+1)
		if j == i+1 {
			return nil, ErrJSONSyntax
		}
		i = j
	}
	if i < len(p.s) && (p.s[i] == 'e' || p.s[i] == 'E') {
		i++
		if i < len(p.s) && (p.s[i] == '+' || p.s[i] == '-') {
			i++
		}
		j := digits(p.s, i)
		if j == i {
			return nil, ErrJSONSyntax
		}
		i = j
	}
	p.i = i
	f, err := strconv.ParseFloat(p.s[start:i], 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return nil, ErrJSONSyntax
	}
	return f, nil
}

func hex4(s string) (rune, bool) {
	if len(s) < 4 {
		return 0, false
	}
	v, err := strconv.ParseUint(s[:4], 16, 16)
	return rune(uint16(v)), err == nil
}

// appendUnit writes one UTF-16 code unit that is a lone surrogate as WTF-8.
func appendUnit(b []byte, u rune) []byte {
	return append(b, 0xed, 0xa0|byte(u>>6&0x1f), 0x80|byte(u&0x3f))
}

// string reads a JSON string; escapes of surrogate pairs join, lone ones stay as WTF-8.
func (p *parser) string() (any, error) {
	p.i++ // "
	var b []byte
	for {
		if p.i >= len(p.s) {
			return nil, ErrJSONSyntax
		}
		c := p.s[p.i]
		switch {
		case c == '"':
			p.i++
			return string(b), nil
		case c < 0x20:
			return nil, ErrJSONSyntax
		case c != '\\':
			b = append(b, c)
			p.i++
			continue
		}
		if p.i+1 >= len(p.s) {
			return nil, ErrJSONSyntax
		}
		e := p.s[p.i+1]
		p.i += 2
		switch e {
		case '"', '\\', '/':
			b = append(b, e)
		case 'b':
			b = append(b, '\b')
		case 'f':
			b = append(b, '\f')
		case 'n':
			b = append(b, '\n')
		case 'r':
			b = append(b, '\r')
		case 't':
			b = append(b, '\t')
		case 'u':
			u, ok := hex4(p.s[p.i:])
			if !ok {
				return nil, ErrJSONSyntax
			}
			p.i += 4
			switch {
			case u >= 0xd800 && u <= 0xdbff:
				if strings.HasPrefix(p.s[p.i:], `\u`) {
					if low, ok := hex4(p.s[p.i+2:]); ok && low >= 0xdc00 && low <= 0xdfff {
						p.i += 6
						b = utf8.AppendRune(b, 0x10000+(u-0xd800)<<10+(low-0xdc00))
						continue
					}
				}
				b = appendUnit(b, u)
			case u >= 0xdc00 && u <= 0xdfff:
				b = appendUnit(b, u)
			default:
				b = utf8.AppendRune(b, u)
			}
		default:
			return nil, ErrJSONSyntax
		}
	}
}

// surrogateAt reports whether s holds a WTF-8 surrogate at i, and its code unit.
func surrogateAt(s string, i int) (rune, bool) {
	if i+2 < len(s) && s[i] == 0xed && s[i+1] >= 0xa0 && s[i+1] <= 0xbf && s[i+2] >= 0x80 && s[i+2] <= 0xbf {
		return 0xd000 | rune(s[i+1]&0x3f)<<6 | rune(s[i+2]&0x3f), true
	}
	return 0, false
}

// Units16 is the JavaScript length of a body string: UTF-16 code units, a WTF-8 surrogate
// counting as one.
func Units16(s string) int {
	n := 0
	for i := 0; i < len(s); {
		if _, ok := surrogateAt(s, i); ok {
			n++
			i += 3
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
		i += size
	}
	return n
}

// CodePoints is zod's codePointLength: UTF-16 units, minus one per well-formed pair.
func CodePoints(s string) int {
	n := 0
	for i := 0; i < len(s); {
		if _, ok := surrogateAt(s, i); ok {
			i += 3
		} else {
			_, size := utf8.DecodeRuneInString(s[i:])
			i += size
		}
		n++
	}
	return n
}

// Slice16 is s.slice(0, n) in UTF-16 code units; a pair cut in half leaves its high surrogate.
func Slice16(s string, n int) string {
	units := 0
	for i := 0; i < len(s); {
		if units >= n {
			return s[:i]
		}
		if _, ok := surrogateAt(s, i); ok {
			units++
			i += 3
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r >= 0x10000 {
			if units+2 > n {
				high := 0xd800 + (r-0x10000)>>10
				return string(appendUnit([]byte(s[:i]), high))
			}
			units += 2
		} else {
			units++
		}
		i += size
	}
	return s
}

// WellFormed is the text Node sends for a JavaScript string (Buffer.from(s, 'utf8')): each lone
// surrogate becomes U+FFFD.
func WellFormed(s string) string {
	if !strings.Contains(s, "\xed") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); {
		if _, ok := surrogateAt(s, i); ok {
			b.WriteString("�")
			i += 3
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

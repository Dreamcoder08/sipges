// Package desktopsnapshot is deploy/desktop/migration/snapshot.mjs and compare.mjs in Go, for
// sipges-desktop --snapshot and --compare (go-rust-stack T72d3): the same requests to the public
// HTTP API, the same snapshot file (format 4) byte for byte, the same comparison rules, output
// lines and exit codes, so a snapshot taken by one compares against the other.
//
// Byte compatibility needs the values JavaScript would hash: this file holds the JSON.parse,
// JSON.stringify, String() and Number() semantics the Node scripts rely on (object key order,
// number text, UTF-16 key sort, lone surrogates), and nothing else.
package desktopsnapshot

import (
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// undefinedValue is JavaScript's undefined: a property that is not there.
type undefinedValue struct{}

// Undefined is the value of a missing property.
var Undefined = undefinedValue{}

// Object is a plain JavaScript object: its own keys come out as JavaScript orders them, array
// indices ascending first, then every other key in insertion order.
type Object struct {
	keys []string
	vals map[string]any
}

// NewObject returns an empty object.
func NewObject() *Object { return &Object{vals: map[string]any{}} }

// Set adds or replaces a property; a replaced one keeps its place.
func (o *Object) Set(key string, value any) {
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = value
}

// Get is the property, or Undefined.
func (o *Object) Get(key string) any {
	if o == nil {
		return Undefined
	}
	if v, ok := o.vals[key]; ok {
		return v
	}
	return Undefined
}

// Has reports an own property.
func (o *Object) Has(key string) bool {
	if o == nil {
		return false
	}
	_, ok := o.vals[key]
	return ok
}

// Len is the number of own properties.
func (o *Object) Len() int {
	if o == nil {
		return 0
	}
	return len(o.keys)
}

// Keys are Object.keys: array indices ascending, then the rest in insertion order.
func (o *Object) Keys() []string {
	if o == nil {
		return nil
	}
	var index []string
	var rest []string
	for _, k := range o.keys {
		if isArrayIndex(k) {
			index = append(index, k)
		} else {
			rest = append(rest, k)
		}
	}
	sortStable(index, func(a, b string) bool {
		x, _ := strconv.ParseUint(a, 10, 64)
		y, _ := strconv.ParseUint(b, 10, 64)
		return x < y
	})
	return append(index, rest...)
}

// isArrayIndex is an array index key: canonical decimal digits below 2^32-1.
func isArrayIndex(k string) bool {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return false
	}
	for i := 0; i < len(k); i++ {
		if k[i] < '0' || k[i] > '9' {
			return false
		}
	}
	n, err := strconv.ParseUint(k, 10, 64)
	return err == nil && n < math.MaxUint32
}

// sortStable is Array.prototype.sort with a comparator: stable.
func sortStable(s []string, less func(a, b string) bool) {
	sort.SliceStable(s, func(i, j int) bool { return less(s[i], s[j]) })
}

// utf16Units are the UTF-16 code units of a WTF-8 string, as JavaScript holds it.
func utf16Units(s string) []uint16 {
	units := make([]uint16, 0, len(s))
	for i := 0; i < len(s); {
		if c, ok := surrogateAt(s, i); ok {
			units = append(units, c)
			i += 3
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		i += size
		if r >= 0x10000 {
			r -= 0x10000
			units = append(units, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF))) //nolint:gosec // r < 2^20
		} else {
			units = append(units, uint16(r)) //nolint:gosec // r < 2^16
		}
	}
	return units
}

// surrogateAt is a lone surrogate held as WTF-8 (ED A0..BF xx) at s[i].
func surrogateAt(s string, i int) (uint16, bool) {
	if i+2 < len(s) && s[i] == 0xED && s[i+1] >= 0xA0 && s[i+1] <= 0xBF && s[i+2] >= 0x80 && s[i+2] <= 0xBF {
		return 0xD000 | uint16(s[i+1]&0x3F)<<6 | uint16(s[i+2]&0x3F), true
	}
	return 0, false
}

// Less is JavaScript's default string order: UTF-16 code units.
func Less(a, b string) bool {
	if isASCII(a) && isASCII(b) {
		return a < b
	}
	x, y := utf16Units(a), utf16Units(b)
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return len(x) < len(y)
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// SortStrings is Array.prototype.sort() without a comparator on strings.
func SortStrings(s []string) { sortStable(s, Less) }

// DecodeText is response.text(): UTF-8 with a leading BOM dropped and every malformed sequence
// replaced by U+FFFD as the WHATWG decoder does (one per maximal subpart).
func DecodeText(b []byte) string {
	if len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
		b = b[3:]
	}
	if utf8.Valid(b) {
		return string(b)
	}
	var out strings.Builder
	for i := 0; i < len(b); {
		c := b[i]
		if c < 0x80 {
			out.WriteByte(c)
			i++
			continue
		}
		need, lower, upper := 0, byte(0x80), byte(0xBF)
		switch {
		case c >= 0xC2 && c <= 0xDF:
			need = 1
		case c >= 0xE0 && c <= 0xEF:
			need = 2
			switch c {
			case 0xE0:
				lower = 0xA0
			case 0xED:
				upper = 0x9F
			}
		case c >= 0xF0 && c <= 0xF4:
			need = 3
			switch c {
			case 0xF0:
				lower = 0x90
			case 0xF4:
				upper = 0x8F
			}
		default:
			out.WriteRune(utf8.RuneError)
			i++
			continue
		}
		j := i + 1
		ok := true
		for k := 0; k < need; k++ {
			if j >= len(b) || b[j] < lower || b[j] > upper {
				ok = false
				break
			}
			lower, upper = 0x80, 0xBF
			j++
		}
		if ok {
			out.Write(b[i:j])
		} else {
			out.WriteRune(utf8.RuneError)
		}
		i = j
	}
	return out.String()
}

var errNotJSON = errors.New("not valid JSON")

// ParseJSON is JSON.parse on a decoded text: numbers as float64, strings as WTF-8 (a lone
// surrogate escape stays one), objects as *Object with a repeated key's last value in its first
// place.
func ParseJSON(text string) (any, error) {
	p := &parser{s: text}
	p.space()
	v, err := p.value(0)
	if err != nil {
		return nil, err
	}
	p.space()
	if p.i != len(p.s) {
		return nil, errNotJSON
	}
	return v, nil
}

type parser struct {
	s string
	i int
}

const maxDepth = 10000

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

func (p *parser) value(depth int) (any, error) {
	if p.i >= len(p.s) || depth > maxDepth {
		return nil, errNotJSON
	}
	switch c := p.s[p.i]; {
	case c == '{':
		return p.object(depth)
	case c == '[':
		return p.array(depth)
	case c == '"':
		return p.str()
	case c == 't':
		return p.word("true", true)
	case c == 'f':
		return p.word("false", false)
	case c == 'n':
		return p.word("null", nil)
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	}
	return nil, errNotJSON
}

func (p *parser) word(w string, v any) (any, error) {
	if !strings.HasPrefix(p.s[p.i:], w) {
		return nil, errNotJSON
	}
	p.i += len(w)
	return v, nil
}

func (p *parser) object(depth int) (any, error) {
	p.i++
	o := NewObject()
	p.space()
	if p.i < len(p.s) && p.s[p.i] == '}' {
		p.i++
		return o, nil
	}
	for {
		p.space()
		if p.i >= len(p.s) || p.s[p.i] != '"' {
			return nil, errNotJSON
		}
		k, err := p.str()
		if err != nil {
			return nil, err
		}
		p.space()
		if p.i >= len(p.s) || p.s[p.i] != ':' {
			return nil, errNotJSON
		}
		p.i++
		p.space()
		v, err := p.value(depth + 1)
		if err != nil {
			return nil, err
		}
		o.Set(k.(string), v)
		p.space()
		if p.i >= len(p.s) {
			return nil, errNotJSON
		}
		if p.s[p.i] == '}' {
			p.i++
			return o, nil
		}
		if p.s[p.i] != ',' {
			return nil, errNotJSON
		}
		p.i++
	}
}

func (p *parser) array(depth int) (any, error) {
	p.i++
	a := []any{}
	p.space()
	if p.i < len(p.s) && p.s[p.i] == ']' {
		p.i++
		return a, nil
	}
	for {
		p.space()
		v, err := p.value(depth + 1)
		if err != nil {
			return nil, err
		}
		a = append(a, v)
		p.space()
		if p.i >= len(p.s) {
			return nil, errNotJSON
		}
		if p.s[p.i] == ']' {
			p.i++
			return a, nil
		}
		if p.s[p.i] != ',' {
			return nil, errNotJSON
		}
		p.i++
	}
}

func (p *parser) hex4() (uint16, bool) {
	if p.i+4 > len(p.s) {
		return 0, false
	}
	var n uint16
	for _, c := range []byte(p.s[p.i : p.i+4]) {
		var d byte
		switch {
		case c >= '0' && c <= '9':
			d = c - '0'
		case c >= 'a' && c <= 'f':
			d = c - 'a' + 10
		case c >= 'A' && c <= 'F':
			d = c - 'A' + 10
		default:
			return 0, false
		}
		n = n<<4 | uint16(d)
	}
	p.i += 4
	return n, true
}

// writeUnit writes one UTF-16 unit that is not part of a pair (a lone surrogate as WTF-8).
func writeUnit(b *strings.Builder, u uint16) {
	if u >= 0xD800 && u <= 0xDFFF {
		b.WriteByte(0xE0 | byte(u>>12))
		b.WriteByte(0x80 | byte(u>>6&0x3F))
		b.WriteByte(0x80 | byte(u&0x3F))
		return
	}
	b.WriteRune(rune(u))
}

func (p *parser) str() (any, error) {
	p.i++
	var b strings.Builder
	for {
		if p.i >= len(p.s) {
			return nil, errNotJSON
		}
		c := p.s[p.i]
		switch {
		case c == '"':
			p.i++
			return b.String(), nil
		case c < 0x20:
			return nil, errNotJSON
		case c != '\\':
			b.WriteByte(c)
			p.i++
			continue
		}
		p.i++
		if p.i >= len(p.s) {
			return nil, errNotJSON
		}
		e := p.s[p.i]
		p.i++
		switch e {
		case '"', '\\', '/':
			b.WriteByte(e)
		case 'b':
			b.WriteByte('\b')
		case 'f':
			b.WriteByte('\f')
		case 'n':
			b.WriteByte('\n')
		case 'r':
			b.WriteByte('\r')
		case 't':
			b.WriteByte('\t')
		case 'u':
			u, ok := p.hex4()
			if !ok {
				return nil, errNotJSON
			}
			if u >= 0xD800 && u <= 0xDBFF && strings.HasPrefix(p.s[p.i:], `\u`) {
				save := p.i
				p.i += 2
				if low, ok := p.hex4(); ok && low >= 0xDC00 && low <= 0xDFFF {
					b.WriteRune(0x10000 + (rune(u)-0xD800)<<10 + rune(low) - 0xDC00)
					continue
				}
				p.i = save
			}
			writeUnit(&b, u)
		default:
			return nil, errNotJSON
		}
	}
}

func (p *parser) number() (any, error) {
	start := p.i
	if p.s[p.i] == '-' {
		p.i++
	}
	digits := func() int {
		n := 0
		for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
			p.i++
			n++
		}
		return n
	}
	if p.i < len(p.s) && p.s[p.i] == '0' {
		p.i++
	} else if digits() == 0 {
		return nil, errNotJSON
	}
	if p.i < len(p.s) && p.s[p.i] == '.' {
		p.i++
		if digits() == 0 {
			return nil, errNotJSON
		}
	}
	if p.i < len(p.s) && (p.s[p.i] == 'e' || p.s[p.i] == 'E') {
		p.i++
		if p.i < len(p.s) && (p.s[p.i] == '+' || p.s[p.i] == '-') {
			p.i++
		}
		if digits() == 0 {
			return nil, errNotJSON
		}
	}
	f, err := strconv.ParseFloat(p.s[start:p.i], 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return nil, errNotJSON
	}
	return f, nil
}

// Stringify is JSON.stringify(value) (indent "") or JSON.stringify(value, null, indent); ok is
// false where JavaScript returns undefined (an undefined value at the top).
func Stringify(v any, indent string) (string, bool) {
	var b strings.Builder
	ok := stringify(&b, v, indent, "")
	return b.String(), ok
}

func stringify(b *strings.Builder, v any, indent, at string) bool {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(x))
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			b.WriteString("null")
		} else {
			b.WriteString(NumberString(x))
		}
	case string:
		quote(b, x)
	case []string:
		items := make([]any, len(x))
		for i, s := range x {
			items[i] = s
		}
		return stringify(b, items, indent, at)
	case []any:
		if len(x) == 0 {
			b.WriteString("[]")
			return true
		}
		inner := at + indent
		b.WriteByte('[')
		for i, item := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if indent != "" {
				b.WriteString("\n" + inner)
			}
			if _, undef := item.(undefinedValue); undef || !stringify(b, item, indent, inner) {
				b.WriteString("null")
			}
		}
		if indent != "" {
			b.WriteString("\n" + at)
		}
		b.WriteByte(']')
	case *Object:
		inner := at + indent
		wrote := false
		b.WriteByte('{')
		for _, k := range x.Keys() {
			item := x.vals[k]
			if _, undef := item.(undefinedValue); undef {
				continue
			}
			if wrote {
				b.WriteByte(',')
			}
			wrote = true
			if indent != "" {
				b.WriteString("\n" + inner)
			}
			quote(b, k)
			b.WriteByte(':')
			if indent != "" {
				b.WriteByte(' ')
			}
			stringify(b, item, indent, inner)
		}
		if wrote && indent != "" {
			b.WriteString("\n" + at)
		}
		b.WriteByte('}')
	default:
		return false
	}
	return true
}

const hexDigits = "0123456789abcdef"

// quote is JSON.stringify of a string: well-formed, so a lone surrogate is escaped.
func quote(b *strings.Builder, s string) {
	b.WriteByte('"')
	for i := 0; i < len(s); {
		if u, ok := surrogateAt(s, i); ok {
			b.WriteString(`\u`)
			for shift := 12; shift >= 0; shift -= 4 {
				b.WriteByte(hexDigits[(u>>shift)&0xF])
			}
			i += 3
			continue
		}
		c := s[i]
		switch {
		case c == '"':
			b.WriteString(`\"`)
		case c == '\\':
			b.WriteString(`\\`)
		case c == '\b':
			b.WriteString(`\b`)
		case c == '\f':
			b.WriteString(`\f`)
		case c == '\n':
			b.WriteString(`\n`)
		case c == '\r':
			b.WriteString(`\r`)
		case c == '\t':
			b.WriteString(`\t`)
		case c < 0x20:
			b.WriteString(`\u00`)
			b.WriteByte(hexDigits[c>>4])
			b.WriteByte(hexDigits[c&0xF])
		default:
			b.WriteByte(c)
		}
		i++
	}
	b.WriteByte('"')
}

// NumberString is Number.prototype.toString(): the shortest digits, plain between 1e-7 and 1e21.
func NumberString(f float64) string {
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
	e := strconv.FormatFloat(f, 'e', -1, 64) // d.ddde±XX
	mantissa, exp, _ := strings.Cut(e, "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	x, _ := strconv.Atoi(exp)
	k, n := len(digits), x+1
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	expSign := "+"
	if n-1 < 0 {
		expSign = "-"
	}
	abs := n - 1
	if abs < 0 {
		abs = -abs
	}
	if k == 1 {
		return sign + digits + "e" + expSign + strconv.Itoa(abs)
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + expSign + strconv.Itoa(abs)
}

// ToString is String(value).
func ToString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case undefinedValue:
		return "undefined"
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return NumberString(x)
	case string:
		return x
	case []any:
		parts := make([]string, len(x))
		for i, item := range x {
			switch item.(type) {
			case nil, undefinedValue:
			default:
				parts[i] = ToString(item)
			}
		}
		return strings.Join(parts, ",")
	case *Object:
		return "[object Object]"
	}
	return ""
}

// ToNumber is Number(value).
func ToNumber(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case string:
		return stringToNumber(x)
	case []any:
		return stringToNumber(ToString(x))
	}
	return math.NaN()
}

func stringToNumber(s string) float64 {
	s = Trim(s)
	switch s {
	case "":
		return 0
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(s) > 2 && s[0] == '0' {
		base := map[byte]int{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}[s[1]]
		if base != 0 {
			f := 0.0
			for _, c := range s[2:] {
				d, err := strconv.ParseUint(string(c), base, 8)
				if err != nil {
					return math.NaN()
				}
				f = f*float64(base) + float64(d)
			}
			return f
		}
	}
	body := strings.TrimLeft(s, "+-")
	if len(s)-len(body) > 1 || body == "" {
		return math.NaN()
	}
	mantissa, exp, hasExp := strings.Cut(strings.ToLower(body), "e")
	if hasExp {
		exp = strings.TrimPrefix(strings.TrimPrefix(exp, "+"), "-")
		if exp == "" || strings.Trim(exp, "0123456789") != "" {
			return math.NaN()
		}
	}
	whole, frac, _ := strings.Cut(mantissa, ".")
	if whole+frac == "" || strings.Trim(whole+frac, "0123456789") != "" {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return math.NaN()
	}
	return f
}

// Trim is String.prototype.trim: JavaScript's white space and line terminators.
func Trim(s string) string {
	return strings.TrimFunc(s, isSpace)
}

// isSpace is JavaScript's \s: white space and line terminators.
func isSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// Truthy is JavaScript's Boolean(value).
func Truthy(v any) bool {
	switch x := v.(type) {
	case nil, undefinedValue:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return true
}

// StrictEqual is ===: primitives by value, objects never (two parsed objects are two objects).
func StrictEqual(a, b any) bool {
	switch x := a.(type) {
	case nil:
		return b == nil
	case undefinedValue:
		_, ok := b.(undefinedValue)
		return ok
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case string:
		y, ok := b.(string)
		return ok && x == y
	case *Object:
		y, ok := b.(*Object)
		return ok && x == y
	}
	return false
}

// IsSafeInteger is Number.isSafeInteger.
func IsSafeInteger(v any) bool {
	f, ok := v.(float64)
	return ok && !math.IsInf(f, 0) && f == math.Trunc(f) && math.Abs(f) <= 1<<53-1
}

// Canonical is client.mjs's canonical: arrays in order, object keys sorted (UTF-16), every value
// with its JSON type.
func Canonical(v any) any {
	switch x := v.(type) {
	case []any:
		out := make([]any, len(x))
		for i, item := range x {
			out[i] = Canonical(item)
		}
		return out
	case *Object:
		keys := x.Keys()
		SortStrings(keys)
		out := NewObject()
		for _, k := range keys {
			out.Set(k, Canonical(x.vals[k]))
		}
		return out
	}
	return v
}

var errURIMalformed = errors.New("URI malformed")

// EncodeURIComponent is encodeURIComponent; a lone surrogate is refused as JavaScript does.
func EncodeURIComponent(s string) (string, error) {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if _, ok := surrogateAt(s, i); ok {
			return "", errURIMalformed
		}
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte("0123456789ABCDEF"[c>>4])
		b.WriteByte("0123456789ABCDEF"[c&0xF])
	}
	return b.String(), nil
}

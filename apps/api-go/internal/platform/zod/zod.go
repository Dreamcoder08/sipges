// Package zod checks JSON.parse values (the records context's model: nil, bool, float64, string,
// []any, *records.Object) as the Zod 4.6 schemas of the TypeScript API do, and reports them as
// parseJson of apps/api/src/platform/http/validation.ts does: the same issues, in the same order,
// with the same codes and English messages (docs/adr/0007). The rules:
//
//   - the type check runs first; a type error aborts every check without `when`;
//   - `.trim()` rewrites the string for the checks after it, and runs only on a string;
//   - length checks run on any value with a `length` (strings in code points, arrays, objects
//     with a "length" key), in schema order, even after a type error;
//   - a refinement runs only when nothing before it aborted.
package zod

import (
	"math"
	"regexp"
	"strconv"
	"strings"

	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

const maxSafeInteger = 9007199254740991

type undefinedValue struct{}

// Undefined is an absent key; Field returns it.
var Undefined any = undefinedValue{}

// IsUndefined reports whether v is an absent key.
func IsUndefined(v any) bool { _, ok := v.(undefinedValue); return ok }

// Field is obj[key].
func Field(o *records.Object, key string) any {
	if v, ok := o.Get(key); ok {
		return v
	}
	return Undefined
}

type issue struct {
	code, message string
	path          []any
	continues     bool
}

// Issues collects a schema's raw issues.
type Issues []issue

// Add appends an issue that aborts later checks.
func (p *Issues) Add(code, message string) {
	*p = append(*p, issue{code: code, message: message})
}

// AddContinue appends an issue later checks still run after (`continue: true`).
func (p *Issues) AddContinue(code, message string) {
	*p = append(*p, issue{code: code, message: message, continues: true})
}

// AddAt is Add for an issue that names its own path, such as a record's invalid key.
func (p *Issues) AddAt(key any, code, message string) {
	*p = append(*p, issue{code: code, message: message, path: []any{key}})
}

// Aborted is util.aborted: some issue stops later checks without `when`.
func (p Issues) Aborted() bool {
	for _, iss := range p {
		if !iss.continues {
			return true
		}
	}
	return false
}

// Merge is prefixIssues: child's issues, one key deeper.
func (p *Issues) Merge(key any, child Issues) {
	for _, iss := range child {
		iss.path = append([]any{key}, iss.path...)
		*p = append(*p, iss)
	}
}

// Received is Zod's name for the type of a JSON.parse value.
func Received(v any) string {
	switch x := v.(type) {
	case undefinedValue:
		return "undefined"
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "boolean"
	case float64:
		switch {
		case math.IsInf(x, 1):
			return "Infinity"
		case math.IsInf(x, -1):
			return "-Infinity"
		}
		return "number"
	case []any:
		return "array"
	}
	return "object"
}

// InvalidType appends the type check's issue.
func (p *Issues) InvalidType(expected string, v any) {
	p.Add("invalid_type", "Invalid input: expected "+expected+", received "+Received(v))
}

// lengthOf is what the length checks read: `value.length`, and the origin that names it.
func lengthOf(v any) (n float64, origin string, ok bool) {
	switch x := v.(type) {
	case string:
		return float64(records.CodePoints(x)), "string", true
	case []any:
		return float64(len(x)), "array", true
	case *records.Object:
		if l, has := x.Get("length"); has {
			return toNumber(l), "unknown", true
		}
	}
	return 0, "", false
}

// length is .min(bound) (min true) or .max(bound); NaN fails both.
func (p *Issues) length(v any, bound int, min bool) {
	n, origin, ok := lengthOf(v)
	if !ok {
		return
	}
	adj, code, word := "<=", "too_big", "Too big: "
	if min {
		adj, code, word = ">=", "too_small", "Too small: "
	}
	if min && n >= float64(bound) || !min && n <= float64(bound) {
		return
	}
	unit := map[string]string{"string": "characters", "array": "items"}[origin]
	text := "expected " + origin + " to be " + adj + strconv.Itoa(bound)
	if unit != "" {
		text = "expected " + origin + " to have " + adj + strconv.Itoa(bound) + " " + unit
	}
	p.AddContinue(code, word+text)
}

// toNumber is JavaScript's ToNumber of a parsed JSON value.
func toNumber(v any) float64 {
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
		switch len(x) {
		case 0:
			return 0
		case 1:
			switch item := x[0].(type) {
			case nil:
				return 0
			case bool, *records.Object:
				return math.NaN()
			default:
				return toNumber(item)
			}
		}
	}
	return math.NaN()
}

var (
	jsRadix   = regexp.MustCompile(`^0(?:[xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)$`)
	jsDecimal = regexp.MustCompile(`^[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)$`)
)

// stringToNumber is Number(s).
func stringToNumber(s string) float64 {
	s = records.TrimJS(s)
	switch {
	case s == "":
		return 0
	case jsRadix.MatchString(s):
		base := map[byte]int{'x': 16, 'o': 8, 'b': 2}[s[1]|0x20]
		f := 0.0
		for _, c := range strings.ToLower(s[2:]) {
			d, _ := strconv.ParseUint(string(c), base, 8)
			f = f*float64(base) + float64(d)
		}
		return f
	case jsDecimal.MatchString(s):
		if strings.HasSuffix(s, "Infinity") {
			return math.Inf(map[bool]int{true: -1, false: 1}[s[0] == '-'])
		}
		f, _ := strconv.ParseFloat(s, 64)
		return f
	}
	return math.NaN()
}

// Str is z.string() with its checks, in this order: .trim(), .min(Min), .max(Max), and a
// refinement refusing NUL. A zero bound is no check.
type Str struct {
	Trim     bool
	Min, Max int
	NoNUL    bool
}

// Parse returns the (trimmed) string and the issues.
func (s Str) Parse(v any) (string, Issues) {
	var p Issues
	text, ok := v.(string)
	if !ok {
		p.InvalidType("string", v)
	} else if s.Trim {
		text = records.TrimJS(text)
		v = text
	}
	if s.Min > 0 {
		p.length(v, s.Min, true)
	}
	if s.Max > 0 {
		p.length(v, s.Max, false)
	}
	if s.NoNUL && !p.Aborted() && strings.ContainsRune(text, 0) {
		p.AddContinue("custom", "Invalid input")
	}
	return text, p
}

// Num is z.number() with its checks, in this order: .int(), .positive(), .min(Min), .max(Max).
type Num struct {
	Int, Positive bool
	Min, Max      *float64
}

// Bound makes a Num bound from a literal.
func Bound(f float64) *float64 { return &f }

// Parse returns the number and the issues.
func (n Num) Parse(v any) (float64, Issues) {
	var p Issues
	f, ok := v.(float64)
	if !ok || math.IsInf(f, 0) {
		p.InvalidType("number", v)
		return 0, p
	}
	if n.Int {
		if f != math.Trunc(f) {
			p.Add("invalid_type", "Invalid input: expected int, received number")
			return 0, p
		}
		if f > maxSafeInteger {
			p.AddContinue("too_big", "Too big: expected int to be <="+strconv.Itoa(maxSafeInteger))
		}
		if f < -maxSafeInteger {
			p.AddContinue("too_small", "Too small: expected int to be >=-"+strconv.Itoa(maxSafeInteger))
		}
	}
	if n.Positive && !(f > 0) {
		p.AddContinue("too_small", "Too small: expected number to be >0")
	}
	if n.Min != nil && f < *n.Min {
		p.AddContinue("too_small", "Too small: expected number to be >="+records.NumberString(*n.Min))
	}
	if n.Max != nil && f > *n.Max {
		p.AddContinue("too_big", "Too big: expected number to be <="+records.NumberString(*n.Max))
	}
	return f, p
}

// Bool is z.boolean().
func Bool(v any) (bool, Issues) {
	var p Issues
	b, ok := v.(bool)
	if !ok {
		p.InvalidType("boolean", v)
	}
	return b, p
}

// Enum is z.enum(values).
func Enum(v any, values []string) (string, Issues) {
	var p Issues
	s, ok := v.(string)
	if ok {
		for _, value := range values {
			if s == value {
				return s, nil
			}
		}
	}
	p.Add("invalid_value", `Invalid option: expected one of "`+strings.Join(values, `"|"`)+`"`)
	return "", p
}

// Object is z.object's type check; a schema reads its keys with Field and drops the others.
func Object(v any, p *Issues) (*records.Object, bool) {
	o, ok := v.(*records.Object)
	if !ok {
		p.InvalidType("object", v)
	}
	return o, ok
}

// ToIssues is toIssues of validation.ts: an invalid_type under an absent top-level key becomes
// "Field required". Loc follows records.AppendIssues, without its leading "body".
func ToIssues(p Issues, body any) []records.Issue {
	out := make([]records.Issue, 0, len(p))
	for _, iss := range p {
		missing := false
		if iss.code == "invalid_type" && len(iss.path) > 0 {
			if o, isObject := body.(*records.Object); !isObject {
				missing = true
			} else if key, isKey := iss.path[0].(string); isKey {
				_, has := o.Get(key)
				missing = !has
			}
		}
		if missing {
			out = append(out, records.Issue{Type: "missing", Loc: iss.path, Msg: "Field required"})
			continue
		}
		out = append(out, records.Issue{Type: iss.code, Loc: iss.path, Msg: iss.message})
	}
	return out
}

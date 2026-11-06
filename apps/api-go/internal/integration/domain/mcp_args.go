//nolint:misspell // Spanish text, verbatim from the TypeScript API.
package domain

import (
	"math"
	"strconv"
	"strings"
	"unicode/utf8"

	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The input schemas of mcp-tools.ts, with zod 4's answers. testdata/mcp.mjs records them from the
// real schemas; a zod upgrade that changes one fails ../domain/mcp_args_test.go. What surprises:
//
//   - a length check also runs after a type error, on anything with a `.length` (an array given to
//     a string field, an object with a key "length"), so one field can give two issues;
//   - an array over its maximum gives that one issue and its elements are never read;
//   - strings are measured in code points, not UTF-16 units;
//   - an integer past the safe range gives an issue and min and max still run.

// schema reads one value; present is false for an absent key. It answers the parsed value and
// whether there is one: an absent optional value leaves no key.
type schema interface {
	parse(v any, present bool, path string, issues *[]string) (any, bool)
}

func addIssue(issues *[]string, path, message string) {
	if path == "" {
		path = "argumentos"
	}
	*issues = append(*issues, path+": "+message)
}

func child(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

// receivedName is the type name of "expected X, received Y".
func receivedName(v any, present bool) string {
	switch x := v.(type) {
	case nil:
		if !present {
			return "undefined"
		}
		return "null"
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
	case string:
		return "string"
	case []any:
		return "array"
	}
	return "object"
}

func invalidType(issues *[]string, path, expected string, v any, present bool) {
	addIssue(issues, path, "Invalid input: expected "+expected+", received "+receivedName(v, present))
}

// ---- Lengths

type length struct {
	min, max int // min 0 means none
}

// measured is `.length` of a value that has one. A string is counted in code points.
func measured(v any) (float64, string, bool) {
	switch x := v.(type) {
	case string:
		return float64(codePoints(x)), "string", true
	case []any:
		return float64(len(x)), "array", true
	case *records.Object:
		if value, ok := x.Get("length"); ok {
			return numberOf(value), "unknown", true
		}
	}
	return 0, "", false
}

// codePoints is String#length minus the surrogate pairs; a lone surrogate (three bytes of WTF-8)
// is one.
func codePoints(s string) int {
	count := 0
	for i := 0; i < len(s); count++ {
		if s[i] == 0xed && i+2 < len(s) && s[i+1] >= 0xa0 {
			i += 3
			continue
		}
		_, size := utf8.DecodeRuneInString(s[i:])
		i += size
	}
	return count
}

// numberOf is ToNumber of a decoded JSON value, as `<=` reads it: NaN compares false both ways.
func numberOf(v any) float64 {
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
		return NumberJS(x)
	case []any:
		return NumberJS(arrayText(x))
	}
	return NumberJS("[object Object]")
}

// arrayText is Array#toString, the primitive `<=` reads from an array. One builder serves every
// level: a client chooses the nesting, and joining at each level would cost size × depth.
func arrayText(items []any) string {
	var b strings.Builder
	writeArrayText(&b, items)
	return b.String()
}

func writeArrayText(b *strings.Builder, items []any) {
	for i, item := range items {
		if i > 0 {
			b.WriteByte(',')
		}
		switch x := item.(type) {
		case nil:
		case bool:
			b.WriteString(strconv.FormatBool(x))
		case float64:
			b.WriteString(records.NumberString(x))
		case string:
			b.WriteString(x)
		case []any:
			writeArrayText(b, x)
		default:
			b.WriteString("[object Object]")
		}
	}
}

func tooBig(origin string, limit int) string {
	bound := "<=" + strconv.Itoa(limit)
	switch origin {
	case "string":
		return "Too big: expected string to have " + bound + " characters"
	case "array":
		return "Too big: expected array to have " + bound + " items"
	}
	return "Too big: expected " + origin + " to be " + bound
}

func tooSmall(origin string, limit int) string {
	bound := ">=" + strconv.Itoa(limit)
	switch origin {
	case "string":
		return "Too small: expected string to have " + bound + " characters"
	case "array":
		return "Too small: expected array to have " + bound + " items"
	}
	return "Too small: expected " + origin + " to be " + bound
}

func (l length) check(v any, path string, issues *[]string) {
	size, origin, ok := measured(v)
	if !ok {
		return
	}
	if l.min > 0 && !(size >= float64(l.min)) {
		addIssue(issues, path, tooSmall(origin, l.min))
	}
	if !(size <= float64(l.max)) {
		addIssue(issues, path, tooBig(origin, l.max))
	}
}

// ---- Types

type stringSchema struct{ length }

func (s stringSchema) parse(v any, present bool, path string, issues *[]string) (any, bool) {
	if _, ok := v.(string); !ok {
		invalidType(issues, path, "string", v, present)
	}
	s.check(v, path, issues)
	return v, true
}

type intSchema struct{ min, max int }

func (s intSchema) parse(v any, present bool, path string, issues *[]string) (any, bool) {
	n, ok := v.(float64)
	if !ok || math.IsInf(n, 0) {
		invalidType(issues, path, "number", v, present)
		return v, true
	}
	if n != math.Trunc(n) {
		addIssue(issues, path, "Invalid input: expected int, received number")
		return v, true
	}
	if n > maxSafeInteger {
		addIssue(issues, path, "Too big: expected int to be <=9007199254740991")
	}
	if n < -maxSafeInteger {
		addIssue(issues, path, "Too small: expected int to be >=-9007199254740991")
	}
	if n < float64(s.min) {
		addIssue(issues, path, tooSmall("number", s.min))
	}
	if n > float64(s.max) {
		addIssue(issues, path, tooBig("number", s.max))
	}
	return v, true
}

type arraySchema struct {
	element schema
	max     int
}

func (s arraySchema) parse(v any, present bool, path string, issues *[]string) (any, bool) {
	limit := length{max: s.max}
	items, ok := v.([]any)
	if !ok {
		invalidType(issues, path, "array", v, present)
		limit.check(v, path, issues)
		return v, true
	}
	if len(items) > s.max {
		limit.check(v, path, issues)
		return v, true
	}
	out := make([]any, len(items))
	for i, item := range items {
		out[i], _ = s.element.parse(item, true, child(path, strconv.Itoa(i)), issues)
	}
	return out, true
}

type optionalSchema struct{ inner schema }

func (s optionalSchema) parse(v any, present bool, path string, issues *[]string) (any, bool) {
	if !present {
		return nil, false
	}
	return s.inner.parse(v, present, path, issues)
}

type defaultSchema struct {
	inner schema
	value any
}

func (s defaultSchema) parse(v any, present bool, path string, issues *[]string) (any, bool) {
	if !present {
		return s.value, true
	}
	return s.inner.parse(v, present, path, issues)
}

type recordSchema struct{}

// parse keeps every key but "__proto__", which zod refuses to copy.
func (recordSchema) parse(v any, present bool, path string, issues *[]string) (any, bool) {
	input, ok := v.(*records.Object)
	if !ok {
		invalidType(issues, path, "record", v, present)
		return v, true
	}
	out := records.NewObject()
	for _, key := range input.Keys() {
		if key != "__proto__" {
			value, _ := input.Get(key)
			out.Set(key, value)
		}
	}
	return out, true
}

type objectField struct {
	name  string
	value schema
}

// objectSchema is z.object: fields in its own order, unknown keys dropped.
type objectSchema []objectField

func (s objectSchema) parse(v any, present bool, path string, issues *[]string) (any, bool) {
	input, ok := v.(*records.Object)
	if !ok {
		invalidType(issues, path, "object", v, present)
		return v, true
	}
	out := records.NewObject()
	for _, f := range s {
		value, found := input.Get(f.name)
		if parsed, keep := f.value.parse(value, found, child(path, f.name), issues); keep {
			out.Set(f.name, parsed)
		}
	}
	return out, true
}

// parseArguments is tool.input.safeParse: the parsed object, or the detail of
// "Argumentos no válidos: <detail>".
func parseArguments(input schema, v any) (*records.Object, string) {
	issues := []string{}
	parsed, _ := input.parse(v, true, "", &issues)
	if len(issues) > 0 {
		return nil, strings.Join(issues, "; ")
	}
	object, _ := parsed.(*records.Object)
	return object, ""
}

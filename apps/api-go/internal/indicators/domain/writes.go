package domain

import (
	"bytes"
	"math"
	"strconv"
	"strings"

	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The bodies of POST /system/irsa/config and POST /system/irsa/snapshot, read as the TypeScript
// routes read them: Hono's c.req.json() (the body's UTF-8 text, BOM dropped, through JSON.parse,
// whatever the Content-Type), then parseJson with the zod schemas IrsaConfigUpdate and
// IrsaSnapshotCreate of packages/contracts/src/indicators.ts, whose issues become the FastAPI
// shaped 422 of platform/http/validation.ts. testdata/writes.json pins the answers.
//
// Known limits, shared with the other Go ports: encoding/json replaces a lone UTF-16 surrogate
// escape (and each invalid UTF-8 byte) with U+FFFD where JavaScript keeps it, and refuses
// nesting deeper than 10 000 levels, which JSON.parse reads.

// Issue is one ValidationIssue: {type, loc, msg}.
type Issue struct {
	Type string
	// Loc holds strings and ints.
	Loc []any
	Msg string
}

var invalidJSON = []Issue{{Type: "json_invalid", Loc: []any{"body"}, Msg: "JSON decode error"}}

// parseBody is Request.json(): the text without a leading BOM, through JSON.parse.
func parseBody(body []byte) (any, bool) {
	v, err := js.Parse(bytes.TrimPrefix(body, []byte("\xef\xbb\xbf")))
	return v, err == nil
}

// received is zod 4's name for the type of a value it refused.
func received(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case string:
		return "string"
	case []any:
		return "array"
	case *js.Object:
		return "object"
	case float64:
		switch {
		case math.IsInf(x, 1):
			return "Infinity"
		case math.IsInf(x, -1):
			return "-Infinity"
		}
	}
	return "number"
}

func expected(what string, v any, loc ...any) Issue {
	return Issue{
		Type: "invalid_type",
		Loc:  append([]any{"body"}, loc...),
		Msg:  "Invalid input: expected " + what + ", received " + received(v),
	}
}

// payloadOf checks the body is an object with an object `payload` (z.object({payload:
// z.object(...)})); toIssues names an absent key "missing".
func payloadOf(body any) (*js.Object, []Issue) {
	root, ok := body.(*js.Object)
	if !ok {
		return nil, []Issue{expected("object", body)}
	}
	value, present := root.Get("payload")
	if !present {
		return nil, []Issue{{Type: "missing", Loc: []any{"body", "payload"}, Msg: "Field required"}}
	}
	payload, ok := value.(*js.Object)
	if !ok {
		return nil, []Issue{expected("object", value, "payload")}
	}
	return payload, nil
}

// finite is z.number(): a finite number.
func finite(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok && !math.IsInf(f, 0) && !math.IsNaN(f)
}

// record is z.record(z.string(), value): an object (not an array or null) whose own keys are
// checked in property order. A "__proto__" key is neither checked nor kept: zod assigns it to
// the new object, which sets the prototype instead of an own property.
func record(v any, loc []any, check func(any, []any) (any, []Issue)) (*js.Object, []Issue) {
	o, ok := v.(*js.Object)
	if !ok {
		return nil, []Issue{expected("record", v, loc...)}
	}
	out := js.NewObject()
	var issues []Issue
	for _, key := range o.Keys() {
		if key == "__proto__" {
			continue
		}
		value, _ := o.Get(key)
		parsed, bad := check(value, append(loc[:len(loc):len(loc)], key))
		issues = append(issues, bad...)
		out.Set(key, parsed)
	}
	return out, issues
}

func number(v any, loc []any) (any, []Issue) {
	f, ok := finite(v)
	if !ok {
		return nil, []Issue{expected("number", v, loc...)}
	}
	if f == 0 {
		f = 0 // JSON.stringify writes -0 as 0
	}
	return f, nil
}

// band is z.tuple([z.number(), z.number()]): a length issue first; too short checks nothing
// else, too long still checks the first two items.
func band(v any, loc []any) (any, []Issue) {
	items, ok := v.([]any)
	if !ok {
		return nil, []Issue{expected("tuple", v, loc...)}
	}
	var issues []Issue
	switch {
	case len(items) < 2:
		return nil, []Issue{{Type: "too_small", Loc: append([]any{"body"}, loc...), Msg: "Too small: expected array to have >=2 items"}}
	case len(items) > 2:
		issues = append(issues, Issue{Type: "too_big", Loc: append([]any{"body"}, loc...), Msg: "Too big: expected array to have <=2 items"})
	}
	out := make([]any, 2)
	for i := range out {
		parsed, bad := number(items[i], append(loc[:len(loc):len(loc)], i))
		issues = append(issues, bad...)
		out[i] = parsed
	}
	return out, issues
}

// ParseConfigUpdate reads a POST /system/irsa/config body. It returns the patch the engine's
// irsa_config_patch takes (JSON.stringify of the parsed payload: only weights, thresholds and
// contributions, in that order) or the issues of the 422.
func ParseConfigUpdate(body []byte) ([]byte, []Issue) {
	v, ok := parseBody(body)
	if !ok {
		return nil, invalidJSON
	}
	payload, issues := payloadOf(v)
	if issues != nil {
		return nil, issues
	}
	patch := js.NewObject()
	for _, field := range []struct {
		key   string
		check func(any, []any) (any, []Issue)
	}{
		{"weights", number},
		{"thresholds", band},
		{"contributions", number},
	} {
		value, present := payload.Get(field.key)
		if !present {
			continue
		}
		parsed, bad := record(value, []any{"payload", field.key}, field.check)
		issues = append(issues, bad...)
		if parsed != nil {
			patch.Set(field.key, parsed)
		}
	}
	if issues != nil {
		return nil, issues
	}
	return js.Stringify(patch), nil
}

// ParseSnapshotCreate reads a POST /system/irsa/snapshot body and returns the note to store,
// noteText(payload.note): Python's str(note or ""), or the issues of the 422.
func ParseSnapshotCreate(body []byte) (string, []Issue) {
	v, ok := parseBody(body)
	if !ok {
		return "", invalidJSON
	}
	payload, issues := payloadOf(v)
	if issues != nil {
		return "", issues
	}
	note, _ := payload.Get("note")
	if hasNUL(note) {
		return "", []Issue{{Type: "custom", Loc: []any{"body", "payload"}, Msg: "Text must not contain NUL characters"}}
	}
	return noteText(note), nil
}

// hasNUL reports whether String(note ?? ”) holds U+0000: only strings, also inside arrays
// (Array.prototype.join), can; an object reads as "[object Object]".
func hasNUL(v any) bool {
	switch x := v.(type) {
	case string:
		return strings.ContainsRune(x, 0)
	case []any:
		for _, item := range x {
			if hasNUL(item) {
				return true
			}
		}
	}
	return false
}

// noteText is the route's noteText: ” for undefined, null, false, 0 and ”, the string itself,
// else JSON.stringify(value).
func noteText(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case bool:
		if !x {
			return ""
		}
	case float64:
		if x == 0 {
			return ""
		}
	case string:
		return x
	}
	return string(js.Stringify(v))
}

// PyFloat is pyFloat (Python's str(float)): an integral value keeps one decimal ("25.0").
func PyFloat(x float64) string {
	if x == math.Trunc(x) && !math.IsInf(x, 0) {
		if x == 0 {
			return "0.0" // (-0).toFixed(1)
		}
		if math.Abs(x) < 1e21 {
			return strconv.FormatFloat(x, 'f', 1, 64) // toFixed(1) is exact for integers
		}
	}
	return js.NumberString(x)
}

// ValidationBody is c.json({detail: issues}) as JSON.stringify writes it (a key in loc keeps
// U+2028 and U+2029 unescaped, unlike encoding/json).
func ValidationBody(issues []Issue) []byte {
	b := []byte(`{"detail":[`)
	for i, issue := range issues {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"type":`...)
		b = js.AppendString(b, issue.Type)
		b = append(b, `,"loc":[`...)
		for j, part := range issue.Loc {
			if j > 0 {
				b = append(b, ',')
			}
			switch p := part.(type) {
			case int:
				b = strconv.AppendInt(b, int64(p), 10)
			case string:
				b = js.AppendString(b, p)
			}
		}
		b = append(b, `],"msg":`...)
		b = js.AppendString(b, issue.Msg)
		b = append(b, '}')
	}
	return append(b, "]}"...)
}

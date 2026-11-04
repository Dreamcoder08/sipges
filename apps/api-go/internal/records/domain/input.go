package domain

import "strconv"

// The request bodies of the write routes, checked as the zod schemas RecordIn and ImportIn of
// packages/contracts/src/records.ts (zod 4) and reported as parseJson of
// apps/api/src/platform/http/validation.ts does (docs/adr/0007).

// Issue is one FastAPI-style validation error: {"type", "loc", "msg"}. Loc holds strings and
// ints (array indexes), after the leading "body".
type Issue struct {
	Type string
	Loc  []any
	Msg  string
}

// JSONInvalid is the 422 of a body JSON.parse refuses.
var JSONInvalid = []Issue{{Type: "json_invalid", Msg: "JSON decode error"}}

// AppendIssues writes {"detail":[…]} with the given issues.
func AppendIssues(b []byte, issues []Issue) []byte {
	b = append(b, `{"detail":[`...)
	for i, issue := range issues {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"type":`...)
		b = appendString(b, issue.Type)
		b = append(b, `,"loc":["body"`...)
		for _, p := range issue.Loc {
			b = append(b, ',')
			switch v := p.(type) {
			case int:
				b = strconv.AppendInt(b, int64(v), 10)
			case string:
				b = appendString(b, v)
			}
		}
		b = append(b, `],"msg":`...)
		b = appendString(b, issue.Msg)
		b = append(b, '}')
	}
	return append(b, "]}"...)
}

// received is zod's name for the type of a JSON.parse value.
func received(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	}
	return "object"
}

func invalidType(expected string, v any, loc ...any) Issue {
	return Issue{Type: "invalid_type", Loc: loc, Msg: "Invalid input: expected " + expected + ", received " + received(v)}
}

// missing is toIssues' rewrite of an invalid_type issue whose first path key is absent.
func missing(key string) Issue { return Issue{Type: "missing", Loc: []any{key}, Msg: "Field required"} }

// record is z.record(z.string(), …)'s output: the same own keys in order, minus "__proto__",
// which zod never writes onto the plain object it builds.
func record(o *Object) *Object {
	out := NewObject()
	for _, k := range o.Keys() {
		if k == "__proto__" {
			continue
		}
		v, _ := o.Get(k)
		out.Set(k, v)
	}
	return out
}

// hasNUL is hasNul of the contracts: a NUL in any key or string, at any depth.
func hasNUL(v any) bool {
	switch x := v.(type) {
	case string:
		return containsNUL(x)
	case []any:
		for _, item := range x {
			if hasNUL(item) {
				return true
			}
		}
	case *Object:
		for _, k := range x.Keys() {
			inner, _ := x.Get(k)
			if containsNUL(k) || hasNUL(inner) {
				return true
			}
		}
	}
	return false
}

func containsNUL(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == 0 {
			return true
		}
	}
	return false
}

// RecordInput is RecordIn.safeParse: the payload object, or the issues.
func RecordInput(body any) (*Object, []Issue) {
	o, ok := body.(*Object)
	if !ok {
		return nil, []Issue{invalidType("object", body)}
	}
	value, present := o.Get("payload")
	if !present {
		return nil, []Issue{missing("payload")}
	}
	given, ok := value.(*Object)
	if !ok {
		return nil, []Issue{{Type: "invalid_type", Loc: []any{"payload"}, Msg: "Payload must be an object"}}
	}
	payload := record(given)
	if hasNUL(payload) {
		return nil, []Issue{{Type: "custom", Loc: []any{"payload"}, Msg: "Text must not contain NUL characters"}}
	}
	return payload, nil
}

// Import is the parsed ImportIn body.
type Import struct {
	Rows   []*Object // string values only
	DryRun bool
	Source string
}

// ImportInput is ImportIn.safeParse: rows (at most MaxImportRows records of strings), dry_run
// (default true) and source (default "", at most 200 code points), with zod's issues in the
// schema's key order.
func ImportInput(body any) (Import, []Issue) {
	o, ok := body.(*Object)
	if !ok {
		return Import{}, []Issue{invalidType("object", body)}
	}
	in := Import{DryRun: true}
	var issues []Issue
	switch rows, present := o.Get("rows"); list := rows.(type) {
	case []any:
		if len(list) > MaxImportRows {
			// zod checks the size first and then leaves the elements unread.
			issues = append(issues, Issue{Type: "too_big", Loc: []any{"rows"}, Msg: "Too big: expected array to have <=" + strconv.Itoa(MaxImportRows) + " items"})
			break
		}
		for i, item := range list {
			row, isObject := item.(*Object)
			if !isObject {
				issues = append(issues, invalidType("record", item, "rows", i))
				continue
			}
			for _, k := range row.Keys() {
				if v, _ := row.Get(k); k != "__proto__" {
					if _, isString := v.(string); !isString {
						issues = append(issues, invalidType("string", v, "rows", i, k))
					}
				}
			}
			in.Rows = append(in.Rows, record(row))
		}
	default:
		if !present {
			issues = append(issues, missing("rows"))
		} else {
			issues = append(issues, invalidType("array", rows, "rows"))
		}
	}
	if v, present := o.Get("dry_run"); present {
		if b, isBool := v.(bool); isBool {
			in.DryRun = b
		} else {
			issues = append(issues, invalidType("boolean", v, "dry_run"))
		}
	}
	if v, present := o.Get("source"); present {
		switch s, isString := v.(string); {
		case !isString:
			issues = append(issues, invalidType("string", v, "source"))
		case CodePoints(s) > 200:
			issues = append(issues, Issue{Type: "too_big", Loc: []any{"source"}, Msg: "Too big: expected string to have <=200 characters"})
		default:
			in.Source = s
		}
	}
	if len(issues) > 0 {
		return Import{}, issues
	}
	return in, nil
}

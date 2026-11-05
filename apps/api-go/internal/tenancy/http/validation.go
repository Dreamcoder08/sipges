package http

import "strings"

// issue is one FastAPI/pydantic-style validation error item (validation.ts ValidationIssue,
// docs/adr/0007), in the TypeScript key order.
type issue struct {
	Type string `json:"type"`
	Loc  []any  `json:"loc"`
	Msg  string `json:"msg"`
}

// The messages zod 4 and validation.ts produce for the tenancy bodies.
const (
	nulMessage     = "Text must not contain NUL characters"
	invalidMessage = "Invalid input"
)

var (
	jsonInvalid = []issue{{Type: "json_invalid", Loc: []any{"body"}, Msg: "JSON decode error"}}
	formInvalid = []issue{{Type: "value_error", Loc: []any{"body"}, Msg: "Invalid form body"}}
)

// schema is a z.object of required strings followed by one refine over all of them.
type schema struct {
	fields []string
	// refine reports whether the parsed strings pass; message is its issue's text.
	refine  func(values []string) bool
	message string
}

func withoutNul(values []string) bool {
	for _, v := range values {
		if strings.ContainsRune(v, 0) {
			return false
		}
	}
	return true
}

var (
	// scopeCreate is ScopeCreate (POST /system/auth/scopes).
	scopeCreate = schema{fields: []string{"company_id", "project_id", "label", "username"}, refine: withoutNul, message: nulMessage}
	// grantCreate is GrantCreate (POST /system/auth/grants).
	grantCreate = schema{fields: []string{"username", "company_id", "project_id"}, refine: withoutNul, message: nulMessage}
	// grantRevoke is GrantRevoke (DELETE /system/auth/grants): bounded lookup text, no NUL.
	grantRevoke = schema{
		fields: []string{"username", "company_id", "project_id"},
		refine: func(values []string) bool {
			for _, v := range values {
				if n := len16(v); n == 0 || n > 120 {
					return false
				}
			}
			return withoutNul(values)
		},
		message: invalidMessage,
	}
	// selectProjectForm is SelectProjectForm (POST /select-project), which has no refine.
	selectProjectForm = schema{fields: []string{"scope"}}
)

// parse is schema.safeParse followed by toIssues: the object check, then each field in the
// schema's order, and the refine only when every field is a string (zod skips refinements
// on input that already has issues). A field absent from the input is "missing".
func (s schema) parse(input jsValue) ([]string, []issue) {
	if input.kind != kindObject {
		return nil, []issue{{Type: "invalid_type", Loc: []any{"body"}, Msg: "Invalid input: expected object, received " + string(input.kind)}}
	}
	var issues []issue
	values := make([]string, len(s.fields))
	for i, name := range s.fields {
		v, present := input.fields[name]
		switch {
		case !present:
			issues = append(issues, issue{Type: "missing", Loc: []any{"body", name}, Msg: "Field required"})
		case v.kind != kindString:
			issues = append(issues, issue{Type: "invalid_type", Loc: []any{"body", name}, Msg: "Invalid input: expected string, received " + string(v.kind)})
		default:
			values[i] = v.text
		}
	}
	if issues != nil {
		return nil, issues
	}
	if s.refine != nil && !s.refine(values) {
		return nil, []issue{{Type: "custom", Loc: []any{"body"}, Msg: s.message}}
	}
	return values, nil
}

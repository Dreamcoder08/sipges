package http

import (
	"io"
	"net/http"
	"strings"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// The JSON bodies of the write routes, read as parseJson of
// apps/api/src/platform/http/validation.ts reads them (Hono's c.req.json(), then the zod 4
// schema, then toIssues): ReviewBatchBody, ReviewDecisionBody (document-lab-routes.ts) and
// DocumentReviewBulkRequest (packages/contracts/src/document-lab.ts). testdata/fixtures.json
// pins every message and its order.

// issue is one item of the 422 body (docs/adr/0007); Loc follows the leading "body".
type issue struct {
	Type string `json:"type"`
	Loc  []any  `json:"loc"`
	Msg  string `json:"msg"`
}

type issuesBody struct {
	Detail []issue `json:"detail"`
}

func writeIssues(w http.ResponseWriter, issues []issue) {
	httpx.WriteJSON(w, http.StatusUnprocessableEntity, issuesBody{Detail: issues})
}

var jsonInvalid = []issue{{Type: "json_invalid", Loc: []any{"body"}, Msg: "JSON decode error"}}

// readJSON is c.req.json(): the decoded body, or false (and the 422 written) when JSON.parse
// throws.
func readJSON(w http.ResponseWriter, r *http.Request) (any, bool) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeIssues(w, jsonInvalid)
		return nil, false
	}
	v, err := records.ParseBody(raw)
	if err != nil {
		writeIssues(w, jsonInvalid)
		return nil, false
	}
	return v, true
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

// validation collects zod's issues; aborted is set by the issues that stop later refinements
// (a wrong type, a value outside an enum, an array over its maximum).
type validation struct {
	input   *records.Object
	issues  []issue
	aborted bool
}

func (v *validation) add(code string, abort bool, msg string, loc ...any) {
	// toIssues: an invalid_type whose first path key is absent from the body is "missing".
	if code == "invalid_type" && len(loc) > 0 {
		if key, ok := loc[0].(string); ok {
			if _, present := v.input.Get(key); !present {
				code, msg = "missing", "Field required"
			}
		}
	}
	v.issues = append(v.issues, issue{Type: code, Loc: append([]any{"body"}, loc...), Msg: msg})
	v.aborted = v.aborted || abort
}

func (v *validation) invalidType(expected string, got any, loc ...any) {
	v.add("invalid_type", true, "Invalid input: expected "+expected+", received "+received(got), loc...)
}

// object checks the root is a JSON object (not an array or null).
func object(body any) (*records.Object, []issue) {
	o, ok := body.(*records.Object)
	if !ok {
		return nil, []issue{{Type: "invalid_type", Loc: []any{"body"}, Msg: "Invalid input: expected object, received " + received(body)}}
	}
	return o, nil
}

// str reads an optional or required z.string(): the value and whether it was a present string.
func (v *validation) str(key string, required bool) (string, bool) {
	raw, present := v.input.Get(key)
	if !present {
		if required {
			v.invalidType("string", nil, key)
		}
		return "", false
	}
	s, ok := raw.(string)
	if !ok {
		v.invalidType("string", raw, key)
		return "", false
	}
	return s, true
}

// maxString is .max(n) on a string: zod counts code points.
func (v *validation) maxString(s string, n int, loc ...any) {
	if records.CodePoints(s) > n {
		v.add("too_big", false, "Too big: expected string to have <="+itoa(n)+" characters", loc...)
	}
}

// batchBody is ReviewBatchBody's output: project_id is never read past `|| scope`.
type batchBody struct {
	ProjectID string
	Filename  string
	SHA256    string
	Items     []*records.Object
}

// parseBatch is ReviewBatchBody.safeParse: z.object (unknown keys dropped) of project_id
// (optional string), filename, sha256 and items (an array of records).
func parseBatch(body any) (batchBody, []issue) {
	o, issues := object(body)
	if issues != nil {
		return batchBody{}, issues
	}
	v := validation{input: o}
	var out batchBody
	out.ProjectID, _ = v.str("project_id", false)
	out.Filename, _ = v.str("filename", true)
	out.SHA256, _ = v.str("sha256", true)
	raw, present := o.Get("items")
	switch items, ok := raw.([]any); {
	case !present:
		v.invalidType("array", nil, "items")
	case !ok:
		v.invalidType("array", raw, "items")
	default:
		for i, item := range items {
			if rec, ok := item.(*records.Object); ok {
				out.Items = append(out.Items, rec)
			} else {
				v.add("invalid_type", true, "Invalid input: expected record, received "+received(item), "items", i)
			}
		}
	}
	return out, v.issues
}

// asText is asText of document-lab-service.ts, Python's `str(x.get(key, ”))` for the JSON
// values an item can hold.
func asText(item *records.Object, key string) string {
	raw, present := item.Get(key)
	if !present {
		return ""
	}
	switch x := raw.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return records.NumberString(x)
	}
	return string(records.Stringify(raw))
}

// decisionBody is ReviewDecisionBody's output.
type decisionBody struct {
	Status, Reviewer, Note string
}

// parseDecision is ReviewDecisionBody.safeParse: status, and reviewer and note defaulting to "".
func parseDecision(body any) (decisionBody, []issue) {
	o, issues := object(body)
	if issues != nil {
		return decisionBody{}, issues
	}
	v := validation{input: o}
	var out decisionBody
	out.Status, _ = v.str("status", true)
	out.Reviewer, _ = v.str("reviewer", false)
	out.Note, _ = v.str("note", false)
	return out, v.issues
}

// bulkBody is DocumentReviewBulkRequest's output; nil means absent.
type bulkBody struct {
	IDs          []string
	Theme        *string
	SourceSHA256 *string
	Status       string
	Note         string
	DryRun       bool
}

var bulkKeys = map[string]bool{"ids": true, "theme": true, "source_sha256": true, "status": true, "note": true, "dry_run": true}

func isLowerHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if (s[i] < '0' || s[i] > '9') && (s[i] < 'a' || s[i] > 'f') {
			return false
		}
	}
	return true
}

// parseBulk is DocumentReviewBulkRequest.safeParse: a strict object, then (unless an aborting
// issue came first) the refinement that ids and a filter exclude each other.
func parseBulk(body any) (bulkBody, []issue) {
	o, issues := object(body)
	if issues != nil {
		return bulkBody{}, issues
	}
	v := validation{input: o}
	var out bulkBody
	if raw, present := o.Get("ids"); present {
		switch ids, ok := raw.([]any); {
		case !ok:
			v.invalidType("array", raw, "ids")
		case len(ids) > 5000:
			v.add("too_big", true, "Too big: expected array to have <=5000 items", "ids")
		default:
			out.IDs = []string{}
			for i, id := range ids {
				s, ok := id.(string)
				if !ok {
					v.invalidType("string", id, "ids", i)
					continue
				}
				v.maxString(s, 64, "ids", i)
				out.IDs = append(out.IDs, s)
			}
			if len(ids) == 0 {
				v.add("too_small", false, "Too small: expected array to have >=1 items", "ids")
			}
		}
	}
	if theme, ok := v.str("theme", false); ok {
		v.maxString(theme, 140, "theme")
		out.Theme = &theme
	}
	if sha, ok := v.str("source_sha256", false); ok {
		if !isLowerHex64(sha) {
			v.add("invalid_format", false, "Invalid string: must match pattern /^[0-9a-f]{64}$/", "source_sha256")
		}
		out.SourceSHA256 = &sha
	}
	raw, _ := o.Get("status")
	switch s, _ := raw.(string); s {
	case "aceptado_para_revision", "corroborado_documentalmente", "descartado":
		out.Status = s
	default:
		v.add("invalid_value", true, `Invalid option: expected one of "aceptado_para_revision"|"corroborado_documentalmente"|"descartado"`, "status")
	}
	if note, ok := v.str("note", false); ok {
		v.maxString(note, 1500, "note")
		out.Note = note
	}
	if raw, present := o.Get("dry_run"); present {
		if b, ok := raw.(bool); ok {
			out.DryRun = b
		} else {
			v.invalidType("boolean", raw, "dry_run")
		}
	}
	var unknown []string
	for _, k := range o.Keys() {
		if !bulkKeys[k] {
			unknown = append(unknown, `"`+k+`"`)
		}
	}
	if len(unknown) > 0 {
		msg := "Unrecognized key: " + unknown[0]
		if len(unknown) > 1 {
			msg = "Unrecognized keys: " + strings.Join(unknown, ", ")
		}
		v.add("unrecognized_keys", false, msg)
	}
	if !v.aborted {
		_, hasIDs := o.Get("ids")
		_, hasTheme := o.Get("theme")
		_, hasSHA := o.Get("source_sha256")
		if hasIDs == (hasTheme || hasSHA) {
			v.add("custom", false, "Indique ids o un filtro por tema o documento, no ambos")
		}
	}
	return out, v.issues
}

func itoa(n int) string { return js.JSNumber(float64(n)) }

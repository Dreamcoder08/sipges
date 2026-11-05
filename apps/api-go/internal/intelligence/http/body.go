package http

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"unicode/utf8"
)

// issue is one item of the 422 body of apps/api/src/platform/http/validation.ts (docs/adr/0007).
type issue struct {
	Type string `json:"type"`
	Loc  []any  `json:"loc"`
	Msg  string `json:"msg"`
}

type issuesBody struct {
	Detail []issue `json:"detail"`
}

// fieldKind is the Zod schema of one body field.
type fieldKind int

const (
	stringField fieldKind = iota // z.string()
	recordField                  // z.record(z.string(), z.unknown())
)

// field is one key of a z.object schema. Optional fields (.optional() or .default(…)) may be
// absent; the handler applies the default.
type field struct {
	name     string
	kind     fieldKind
	optional bool
	// nullable is .nullable(): JSON null passes.
	nullable bool
	// maxCodePoints is .max(n) on a string, which Zod counts in code points; 0 is no limit.
	maxCodePoints int
}

// body is a parsed JSON object: each key's raw JSON value (the last duplicate wins, as
// JSON.parse).
type body map[string]json.RawMessage

// str returns the field's string, or "" when it is absent (every optional string field of
// these schemas defaults to "", and project_id is not read).
func (b body) str(name string) string {
	raw, ok := b[name]
	if !ok {
		return ""
	}
	var s string
	_ = json.Unmarshal(raw, &s) // validated as a JSON string by parseBody
	return s
}

// parseBody is parseJson(c, z.object(fields)): Hono's c.req.json() (Response.text(), which
// drops a byte order mark and replaces invalid UTF-8, then JSON.parse of the whole text), then
// the schema's checks in key order. It writes the 422 itself and returns false on failure.
func parseBody(w http.ResponseWriter, r *http.Request, fields []field) (body, bool) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeIssues(w, issue{Type: "json_invalid", Loc: []any{"body"}, Msg: "JSON decode error"})
		return nil, false
	}
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))
	if !utf8.Valid(raw) {
		raw = decodeUTF8(raw)
	}
	if !validJSON(raw) {
		// Also a body nested beyond encoding/json's depth limit, which JSON.parse would read;
		// the project check of the tenancy middleware already refuses those sent as JSON.
		writeIssues(w, issue{Type: "json_invalid", Loc: []any{"body"}, Msg: "JSON decode error"})
		return nil, false
	}
	trimmed := bytes.TrimLeft(raw, " \t\r\n")
	if kind := jsonType(trimmed); kind != "object" {
		writeIssues(w, issue{Type: "invalid_type", Loc: []any{"body"}, Msg: "Invalid input: expected object, received " + kind})
		return nil, false
	}
	var parsed body
	if err := json.Unmarshal(trimmed, &parsed); err != nil {
		writeIssues(w, issue{Type: "json_invalid", Loc: []any{"body"}, Msg: "JSON decode error"})
		return nil, false
	}
	var found []issue
	for _, f := range fields {
		value, present := parsed[f.name]
		if !present {
			if !f.optional {
				found = append(found, issue{Type: "missing", Loc: []any{"body", f.name}, Msg: "Field required"})
			}
			continue
		}
		got := jsonType(value)
		switch {
		case f.nullable && got == "null":
		case f.kind == stringField && got == "string" && tooLong(value, f.maxCodePoints):
			found = append(found, issue{Type: "too_big", Loc: []any{"body", f.name}, Msg: "Too big: expected string to have <=" + strconv.Itoa(f.maxCodePoints) + " characters"})
		case f.kind == stringField && got != "string":
			found = append(found, issue{Type: "invalid_type", Loc: []any{"body", f.name}, Msg: "Invalid input: expected string, received " + got})
		case f.kind == recordField && got != "object":
			found = append(found, issue{Type: "invalid_type", Loc: []any{"body", f.name}, Msg: "Invalid input: expected record, received " + got})
		}
	}
	if len(found) > 0 {
		writeIssues(w, found...)
		return nil, false
	}
	return parsed, true
}

// tooLong says the JSON string raw holds more than limit code points; a limit of 0 is none.
func tooLong(raw json.RawMessage, limit int) bool {
	if limit == 0 {
		return false
	}
	var s string
	_ = json.Unmarshal(raw, &s) // the caller checked it is a JSON string
	return utf8.RuneCountInString(s) > limit
}

// validJSON is whether JSON.parse reads raw: one JSON value and nothing after it.
func validJSON(raw []byte) bool {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber() // JSON.parse reads 1e400 as Infinity, where float64 decoding fails
	var v any
	if err := dec.Decode(&v); err != nil {
		return false
	}
	_, err := dec.Token()
	return errors.Is(err, io.EOF)
}

// jsonType is Zod's name for the type of a valid JSON value.
func jsonType(raw json.RawMessage) string {
	raw = bytes.TrimLeft(raw, " \t\r\n")
	if len(raw) == 0 {
		return "undefined"
	}
	switch raw[0] {
	case '{':
		return "object"
	case '[':
		return "array"
	case '"':
		return "string"
	case 'n':
		return "null"
	case 't', 'f':
		return "boolean"
	default:
		return "number"
	}
}

func writeIssues(w http.ResponseWriter, found ...issue) {
	writeJSON(w, http.StatusUnprocessableEntity, issuesBody{Detail: found})
}

// decodeUTF8 is the WHATWG UTF-8 decoder (TextDecoder, behind Response.text()): each maximal
// subpart of an ill-formed sequence becomes one U+FFFD, so the code point counts of the
// TypeScript checks (the note length) see the same text.
func decodeUTF8(raw []byte) []byte {
	const replacement = "\uFFFD"
	out := make([]byte, 0, len(raw)+8)
	for i := 0; i < len(raw); {
		b := raw[i]
		if b < 0x80 {
			out = append(out, b)
			i++
			continue
		}
		var need int
		lower, upper := byte(0x80), byte(0xbf)
		switch {
		case b >= 0xc2 && b <= 0xdf:
			need = 1
		case b == 0xe0:
			need, lower = 2, 0xa0
		case b == 0xed:
			need, upper = 2, 0x9f
		case b >= 0xe1 && b <= 0xef:
			need = 2
		case b == 0xf0:
			need, lower = 3, 0x90
		case b == 0xf4:
			need, upper = 3, 0x8f
		case b >= 0xf1 && b <= 0xf3:
			need = 3
		default:
			out = append(out, replacement...)
			i++
			continue
		}
		j := i + 1
		for range need {
			if j >= len(raw) || raw[j] < lower || raw[j] > upper {
				break
			}
			lower, upper = 0x80, 0xbf
			j++
		}
		if j-i == need+1 {
			out = append(out, raw[i:j]...)
		} else {
			out = append(out, replacement...)
		}
		i = j
	}
	return out
}

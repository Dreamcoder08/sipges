package httpx

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
)

// PathParam is c.req.param(name): the ServeMux wildcard value, URI-decoded the way Hono decodes
// route parameters (tryDecodeURIComponent). CanonicalPath already applied decodeURI to the path,
// so only the escapes decodeURI keeps (such as %2F) are left to decode.
func PathParam(r *http.Request, name string) string {
	return tryDecodeComponent(r.PathValue(name))
}

// ValidationIssue is ValidationIssue of apps/api/src/platform/http/validation.ts.
type ValidationIssue struct {
	Type string `json:"type"`
	Loc  []any  `json:"loc"`
	Msg  string `json:"msg"`
}

// IntQuery is parseIntQuery of apps/api/src/platform/http/validation.ts (FastAPI
// `name: int = fallback`): the fallback when the parameter is absent, the FastAPI 422 (written
// to w, false returned) when it does not match /^\s*[+-]?\d+\s*$/, else its value saturated at
// the int64 bounds (JavaScript reads larger ones as huge numbers, which every caller clamps).
func IntQuery(w http.ResponseWriter, r *http.Request, name string, fallback int64) (int64, bool) {
	raw, present := QueryParam(r, name)
	if !present {
		return fallback, true
	}
	if value, ok := parseJSInt(strings.TrimFunc(raw, isJSSpace)); ok {
		return value, true
	}
	WriteJSONText(w, http.StatusUnprocessableEntity, ErrorBody{Detail: []ValidationIssue{{
		Type: "int_parsing",
		Loc:  []any{"query", name},
		Msg:  "Input should be a valid integer, unable to parse string as an integer",
	}}})
	return 0, false
}

// parseJSInt reads [+-]?\d+ with ASCII digits only, as JavaScript's \d.
func parseJSInt(s string) (int64, bool) {
	digits := strings.TrimLeft(s, "+-")
	if len(s)-len(digits) > 1 || digits == "" || strings.Trim(digits, "0123456789") != "" {
		return 0, false
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if errors.Is(err, strconv.ErrRange) {
		if strings.HasPrefix(s, "-") {
			return math.MinInt64, true
		}
		return math.MaxInt64, true
	}
	return v, err == nil
}

// isJSSpace is JavaScript's \s (WhiteSpace and LineTerminator).
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// WriteJSONText is Hono's c.json: v written as JSON.stringify would (no HTML escaping, no
// trailing newline). A value that cannot be encoded answers the onError 500.
func WriteJSONText(w http.ResponseWriter, status int, v any) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(bytes.TrimSuffix(b.Bytes(), []byte("\n")))
}

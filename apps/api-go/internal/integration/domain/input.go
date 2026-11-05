package domain

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The request bodies of the integration write routes, checked as parseJson of
// apps/api/src/platform/http/validation.ts does with the Zod 4 schemas MediaFeedIn,
// AuthorizedSourceConfigIn and AuthorizedSourceImportIn of @sipges/contracts and PreviewIn of
// media-routes.ts: the same issues, in the same order, with the same codes and English messages.
// Bodies are the records context's JSON values (records.ParseBody). The Zod 4.6 rules ported
// (see also internal/ontology/domain/validation.go):
//
//   - the type check runs first; a type error aborts every check without `when`;
//   - `.trim()` rewrites the string before the checks after it, and runs only on a string;
//   - length checks (min, max) run on any value with a `length` (strings in code points, arrays,
//     objects with a "length" key), in schema order, even after a type error;
//   - an array longer than its max reports only that, without reading its elements;
//   - a refinement runs only when nothing before it aborted.
//
// testdata/routes.mjs records the TypeScript answers; runtime_fixtures_test.go pins this port.

// Issue is one FastAPI-style validation item: {"type", "loc", "msg"}.
type Issue struct {
	Type string `json:"type"`
	Loc  []any  `json:"loc"`
	Msg  string `json:"msg"`
}

type flow int

const (
	flowUnset flow = iota
	flowContinue
	flowStop
)

type zodIssue struct {
	code, message string
	path          []any
	flow          flow
}

type issues []zodIssue

type undefinedValue struct{}

func (p *issues) add(code, message string, f flow) {
	*p = append(*p, zodIssue{code: code, message: message, flow: f})
}

func (p issues) aborted() bool {
	for _, iss := range p {
		if iss.flow != flowContinue {
			return true
		}
	}
	return false
}

func (p issues) explicitlyAborted() bool {
	for _, iss := range p {
		if iss.flow == flowStop {
			return true
		}
	}
	return false
}

func (p *issues) merge(key any, child issues) {
	for _, iss := range child {
		iss.path = append([]any{key}, iss.path...)
		*p = append(*p, iss)
	}
}

func received(v any) string {
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

func (p *issues) invalidType(expected string, v any) {
	p.add("invalid_type", "Invalid input: expected "+expected+", received "+received(v), flowUnset)
}

// lengthOf is what the length checks read: `value.length`, and the origin that names it.
func lengthOf(v any) (n float64, origin string, ok bool) {
	switch x := v.(type) {
	case string:
		// Zod 4 counts code points, a lone surrogate as one: WellFormed makes it one rune.
		return float64(utf8.RuneCountInString(records.WellFormed(x))), "string", true
	case []any:
		return float64(len(x)), "array", true
	case *records.Object:
		if l, has := x.Get("length"); has {
			return toNumber(l), "unknown", true
		}
	}
	return 0, "", false
}

// lengthCheck is .min(bound) (min true) or .max(bound); NaN fails both.
func (p *issues) lengthCheck(v any, bound int, min bool) {
	if p.explicitlyAborted() {
		return
	}
	n, origin, ok := lengthOf(v)
	if !ok {
		return
	}
	unit := map[string]string{"string": "characters", "array": "items"}[origin]
	adj, code, word := "<=", "too_big", "Too big: "
	if min {
		adj, code, word = ">=", "too_small", "Too small: "
	}
	if min && n >= float64(bound) || !min && n <= float64(bound) {
		return
	}
	text := "expected " + origin + " to be " + adj + strconv.Itoa(bound)
	if unit != "" {
		text = "expected " + origin + " to have " + adj + strconv.Itoa(bound) + " " + unit
	}
	p.add(code, word+text, flowContinue)
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
		return NumberJS(x)
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

// text is text(max) of the contracts with an optional .min(1): string, trim, max, no NUL, min.
func text(v any, max int, min1 bool) (string, issues) {
	var p issues
	s, ok := v.(string)
	if !ok {
		p.invalidType("string", v)
	} else {
		s = TrimJS(s)
		v = s
	}
	p.lengthCheck(v, max, false)
	if !p.aborted() && strings.ContainsRune(s, 0) {
		p.add("custom", "Invalid input", flowContinue)
	}
	if min1 {
		p.lengthCheck(v, 1, true)
	}
	return s, p
}

// trimmed is z.string().trim().min(1).max(max) (PreviewIn).
func trimmed(v any, max int) (string, issues) {
	var p issues
	s, ok := v.(string)
	if !ok {
		p.invalidType("string", v)
	} else {
		s = TrimJS(s)
		v = s
	}
	p.lengthCheck(v, 1, true)
	p.lengthCheck(v, max, false)
	return s, p
}

// stringArray is z.array(item).max(max).
func stringArray(v any, max int, item func(any) (string, issues)) ([]string, issues) {
	var p issues
	list, ok := v.([]any)
	if !ok {
		p.invalidType("array", v)
		p.lengthCheck(v, max, false)
		return nil, p
	}
	if len(list) > max {
		p.add("too_big", "Too big: expected array to have <="+strconv.Itoa(max)+" items", flowStop)
		return nil, p
	}
	out := make([]string, 0, len(list))
	for i, element := range list {
		value, child := item(element)
		p.merge(i, child)
		out = append(out, value)
	}
	return out, p
}

func boolean(v any) (bool, issues) {
	var p issues
	b, ok := v.(bool)
	if !ok {
		p.invalidType("boolean", v)
	}
	return b, p
}

const maxSafeInteger = 9007199254740991

// postID is z.number().int().positive().max(2147483647).
func postID(v any) (int, issues) {
	var p issues
	f, ok := v.(float64)
	if !ok || math.IsInf(f, 0) {
		p.invalidType("number", v)
		return 0, p
	}
	if f != math.Trunc(f) {
		p.add("invalid_type", "Invalid input: expected int, received number", flowUnset)
		return 0, p
	}
	if f > maxSafeInteger {
		p.add("too_big", "Too big: expected int to be <="+strconv.Itoa(maxSafeInteger), flowContinue)
	}
	if f < -maxSafeInteger {
		p.add("too_small", "Too small: expected int to be >=-"+strconv.Itoa(maxSafeInteger), flowContinue)
	}
	if !(f > 0) {
		p.add("too_small", "Too small: expected number to be >0", flowContinue)
	}
	if f > 2147483647 {
		p.add("too_big", "Too big: expected number to be <=2147483647", flowContinue)
	}
	return int(f), p
}

// object is z.object's type check; unknown keys are dropped.
func object(v any, p *issues) (*records.Object, bool) {
	o, ok := v.(*records.Object)
	if !ok {
		p.invalidType("object", v)
	}
	return o, ok
}

func field(o *records.Object, key string) any {
	if v, ok := o.Get(key); ok {
		return v
	}
	return undefinedValue{}
}

func isUndefined(v any) bool { _, ok := v.(undefinedValue); return ok }

// toLoc maps Zod issues to validation.ts's toIssues: missing keys become "Field required".
func toLoc(p issues, body any) []Issue {
	out := make([]Issue, 0, len(p))
	for _, iss := range p {
		missing := false
		if iss.code == "invalid_type" && len(iss.path) > 0 {
			o, isObject := body.(*records.Object)
			if !isObject {
				missing = true
			} else if key, isKey := iss.path[0].(string); isKey {
				_, has := o.Get(key)
				missing = !has
			}
		}
		loc := append([]any{"body"}, iss.path...)
		if missing {
			out = append(out, Issue{Type: "missing", Loc: loc, Msg: "Field required"})
			continue
		}
		out = append(out, Issue{Type: iss.code, Loc: loc, Msg: iss.message})
	}
	return out
}

// FeedInput is MediaFeedIn after parsing.
type FeedInput struct {
	Name, URL         string
	Keywords          []string
	Territory         string
	AuthorizationNote string
	Enabled           bool
}

// ParseFeedInput is MediaFeedIn.safeParse.
func ParseFeedInput(body any) (FeedInput, []Issue) {
	var p issues
	o, ok := object(body, &p)
	if !ok {
		return FeedInput{}, toLoc(p, body)
	}
	var in FeedInput
	var child issues
	in.Name, child = text(field(o, "name"), 120, true)
	p.merge("name", child)
	in.URL, child = text(field(o, "url"), 500, true)
	p.merge("url", child)
	in.Keywords = []string{}
	if v := field(o, "keywords"); !isUndefined(v) {
		in.Keywords, child = stringArray(v, MaxFeedKeywords, func(item any) (string, issues) { return text(item, 60, true) })
		p.merge("keywords", child)
	}
	if v := field(o, "territory"); !isUndefined(v) {
		in.Territory, child = text(v, 200, false)
		p.merge("territory", child)
	}
	in.AuthorizationNote, child = text(field(o, "authorization_note"), 1000, true)
	p.merge("authorization_note", child)
	in.Enabled = true
	if v := field(o, "enabled"); !isUndefined(v) {
		in.Enabled, child = boolean(v)
		p.merge("enabled", child)
	}
	if len(p) > 0 {
		return FeedInput{}, toLoc(p, body)
	}
	return in, nil
}

// PreviewInput is PreviewIn of media-routes.ts after parsing.
type PreviewInput struct {
	URL      string
	Keywords []string
}

// ParsePreviewInput is PreviewIn.safeParse.
func ParsePreviewInput(body any) (PreviewInput, []Issue) {
	var p issues
	o, ok := object(body, &p)
	if !ok {
		return PreviewInput{}, toLoc(p, body)
	}
	var in PreviewInput
	var child issues
	in.URL, child = trimmed(field(o, "url"), 500)
	p.merge("url", child)
	in.Keywords = []string{}
	if v := field(o, "keywords"); !isUndefined(v) {
		in.Keywords, child = stringArray(v, 30, func(item any) (string, issues) { return trimmed(item, 60) })
		p.merge("keywords", child)
	}
	if len(p) > 0 {
		return PreviewInput{}, toLoc(p, body)
	}
	return in, nil
}

// SourceConfig is AuthorizedSourceConfigIn after parsing.
type SourceConfig struct {
	Enabled                             bool
	Query, Territory, AuthorizationNote string
}

// ParseSourceConfig is AuthorizedSourceConfigIn.safeParse.
func ParseSourceConfig(body any) (SourceConfig, []Issue) {
	var p issues
	o, ok := object(body, &p)
	if !ok {
		return SourceConfig{}, toLoc(p, body)
	}
	var in SourceConfig
	var child issues
	in.Enabled, child = boolean(field(o, "enabled"))
	p.merge("enabled", child)
	for _, f := range []struct {
		key string
		max int
		to  *string
	}{{"query", 100, &in.Query}, {"territory", 200, &in.Territory}, {"authorization_note", 1000, &in.AuthorizationNote}} {
		if v := field(o, f.key); !isUndefined(v) {
			*f.to, child = text(v, f.max, false)
			p.merge(f.key, child)
		}
	}
	if len(p) > 0 {
		return SourceConfig{}, toLoc(p, body)
	}
	return in, nil
}

// SourceImport is AuthorizedSourceImportIn after parsing; Territory is nil when absent.
type SourceImport struct {
	PostID    int
	Territory *string
}

// ParseSourceImport is AuthorizedSourceImportIn.safeParse.
func ParseSourceImport(body any) (SourceImport, []Issue) {
	var p issues
	o, ok := object(body, &p)
	if !ok {
		return SourceImport{}, toLoc(p, body)
	}
	var in SourceImport
	var child issues
	in.PostID, child = postID(field(o, "post_id"))
	p.merge("post_id", child)
	if v := field(o, "territory"); !isUndefined(v) {
		var t string
		t, child = text(v, 200, false)
		p.merge("territory", child)
		in.Territory = &t
	}
	if len(p) > 0 {
		return SourceImport{}, toLoc(p, body)
	}
	return in, nil
}

// Signal is SignalIn of signal-routes.ts after parsing.
type Signal struct {
	SourceName, SourceURL, ExternalID, Text, ObservedAt string
	Territory                                           *string
}

var isoOffsetDateTime = regexp.MustCompile(`^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$`)

// cleanText is cleanText(max) of signal-routes.ts: trim, 1..max, no NUL.
func cleanText(v any, max int) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	s = TrimJS(s)
	n := utf8.RuneCountInString(s)
	return s, n >= 1 && n <= max && !strings.ContainsRune(s, 0)
}

// ErrSignalURL is the TypeError SignalIn's refinement throws on a string `new URL` refuses: the
// route answers the onError 500, as TypeScript does.
type ErrSignalURL struct{}

func (ErrSignalURL) Error() string { return "signal: source_url is not a URL" }

// ParseSignal is SignalIn.safeParse: ok is false for any issue (the route's one 422); err is
// ErrSignalURL when the refinement would throw.
func ParseSignal(body any) (Signal, bool, error) {
	o, isObject := body.(*records.Object)
	if !isObject {
		return Signal{}, false, nil
	}
	var s Signal
	valid := true
	check := func(ok bool) {
		valid = valid && ok
	}
	var ok bool
	s.SourceName, ok = cleanText(field(o, "source_name"), 100)
	check(ok)
	// z.string().url().max(2000).refine(http(s) without credentials)
	raw, isString := field(o, "source_url").(string)
	if !isString {
		check(false)
	} else {
		trimmedURL := TrimJS(raw)
		value := raw
		if _, parses := ParseURL(trimmedURL); parses {
			value = strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(trimmedURL)
		} else {
			check(false)
		}
		check(utf8.RuneCountInString(value) <= 2000)
		u, parses := ParseURL(value)
		if !parses {
			return Signal{}, false, ErrSignalURL{}
		}
		check((u.Protocol == "http:" || u.Protocol == "https:") && u.Username == "" && u.Password == "")
		s.SourceURL = value
	}
	s.ExternalID, ok = cleanText(field(o, "external_id"), 200)
	check(ok)
	s.Text, ok = cleanText(field(o, "text"), 20000)
	check(ok)
	observed, isString := field(o, "observed_at").(string)
	check(isString && isoOffsetDateTime.MatchString(observed))
	s.ObservedAt = observed
	if v := field(o, "territory"); !isUndefined(v) {
		t, ok := cleanText(v, 200)
		check(ok)
		s.Territory = &t
	}
	return s, valid, nil
}

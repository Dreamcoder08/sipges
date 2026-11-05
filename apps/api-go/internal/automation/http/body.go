package http

import (
	"math"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	situations "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// The bodies of the automation write routes are validated as parseJson of
// apps/api/src/platform/http/validation.ts does with the Zod 4 schemas RuleIn, ChannelIn and
// NotificationReadIn of @sipges/contracts: the same issues, in the same order, with the same
// codes and messages. Only the parts of Zod 4.6 those schemas use are ported, with the rules
// internal/ontology/domain/validation.go found, plus unions:
//
//   - a schema's own parse runs first (type check, then an array's elements or an object's keys);
//   - length checks run on any value with a `length`, even after a type error, and measure
//     strings in code points; an array longer than its max reports only that;
//   - a refinement or transform runs only when nothing before it aborted;
//   - a union returns the first option that parses, else the issues of its only non-aborted
//     option, else invalid_union; a discriminated union picks its option by `kind`.
//
// ../testdata/generate.mjs records the TypeScript answers; body_fixtures_test.go pins this.

type flow int

const (
	flowUnset    flow = iota // aborts later checks without a `when`
	flowContinue             // lets every check run
	flowStop                 // also stops the length checks
)

type zodIssue struct {
	code    string
	path    []any
	message string
	flow    flow
}

type undefined struct{}

type result struct{ issues []zodIssue }

func (p *result) add(code, message string, f flow) {
	p.issues = append(p.issues, zodIssue{code: code, message: message, flow: f})
}

func (p *result) aborted() bool {
	for _, iss := range p.issues {
		if iss.flow != flowContinue {
			return true
		}
	}
	return false
}

func (p *result) explicitlyAborted() bool {
	for _, iss := range p.issues {
		if iss.flow == flowStop {
			return true
		}
	}
	return false
}

func (p *result) merge(key any, child result) {
	for _, iss := range child.issues {
		iss.path = append([]any{key}, iss.path...)
		p.issues = append(p.issues, iss)
	}
}

func received(v any) string {
	switch x := v.(type) {
	case undefined:
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

func (p *result) invalidType(expected string, v any) {
	p.add("invalid_type", "Invalid input: expected "+expected+", received "+received(v), flowUnset)
}

// lengthOf is `value.length` for the values that have one: strings (code points), arrays and
// objects with a "length" key.
func lengthOf(v any) (float64, string, bool) {
	switch x := v.(type) {
	case string:
		return float64(utf8.RuneCountInString(x)), "string", true
	case []any:
		return float64(len(x)), "array", true
	case *records.Object:
		if l, ok := x.Get("length"); ok {
			return toNumber(l), "unknown", true
		}
	}
	return 0, "", false
}

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
		if f, err := strconv.ParseFloat(situations.TrimJS(x), 64); err == nil {
			return f
		}
		if situations.TrimJS(x) == "" {
			return 0
		}
	}
	return math.NaN()
}

// length is one .min(n) (lo) or .max(n) check.
func (p *result) length(v any, n int, lo bool) {
	if p.explicitlyAborted() {
		return
	}
	got, origin, ok := lengthOf(v)
	if !ok {
		return
	}
	unit := map[string]string{"string": "characters", "array": "items"}[origin]
	describe := func(adj string) string {
		if unit == "" {
			return "expected " + origin + " to be " + adj + strconv.Itoa(n)
		}
		return "expected " + origin + " to have " + adj + strconv.Itoa(n) + " " + unit
	}
	if lo && !(got >= float64(n)) {
		p.add("too_small", "Too small: "+describe(">="), flowContinue)
	}
	if !lo && !(got <= float64(n)) {
		p.add("too_big", "Too big: "+describe("<="), flowContinue)
	}
}

// text is Text(max) of the contracts — z.string().max(max).refine(no NUL) — then .trim() when
// trim and .min(1) when required.
func text(v any, maxLen int, trim, required bool) (string, result) {
	var p result
	s, ok := v.(string)
	if !ok {
		p.invalidType("string", v)
	}
	p.length(v, maxLen, false)
	if !p.aborted() && strings.ContainsRune(s, 0) {
		p.add("custom", "Text must not contain NUL characters", flowContinue)
	}
	if trim && !p.aborted() {
		s = situations.TrimJS(s)
		v = s
	}
	if required {
		p.length(v, 1, true)
	}
	return s, p
}

func array[T any](v any, lo, hi int, item func(any) (T, result)) ([]T, result) {
	var p result
	list, ok := v.([]any)
	switch {
	case !ok:
		p.invalidType("array", v)
	case hi >= 0 && len(list) > hi:
		p.add("too_big", "Too big: expected array to have <="+strconv.Itoa(hi)+" items", flowStop)
		return nil, p
	}
	out := make([]T, 0, len(list))
	for i, element := range list {
		value, child := item(element)
		p.merge(i, child)
		out = append(out, value)
	}
	if lo >= 0 {
		p.length(v, lo, true)
	}
	if hi >= 0 {
		p.length(v, hi, false)
	}
	return out, p
}

func object(v any, p *result) (*records.Object, bool) {
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
	return undefined{}
}

func enum(v any, values []string) (string, result) {
	var p result
	if s, ok := v.(string); ok {
		for _, want := range values {
			if s == want {
				return s, p
			}
		}
	}
	quoted := make([]string, len(values))
	for i, s := range values {
		quoted[i] = strconv.Quote(s)
	}
	p.add("invalid_value", "Invalid option: expected one of "+strings.Join(quoted, "|"), flowUnset)
	return "", p
}

// positiveInt is z.number().int().positive().
func positiveInt(v any) (int64, result) {
	var p result
	f, ok := v.(float64)
	if !ok || math.IsInf(f, 0) {
		p.invalidType("number", v)
		return 0, p
	}
	switch {
	case f != math.Trunc(f):
		p.add("invalid_type", "Invalid input: expected int, received number", flowUnset)
		return 0, p
	case f > 9007199254740991:
		p.add("too_big", "Too big: expected int to be <=9007199254740991", flowContinue)
	case f < -9007199254740991:
		p.add("too_small", "Too small: expected int to be >=-9007199254740991", flowContinue)
	}
	if !(f > 0) {
		p.add("too_small", "Too small: expected number to be >0", flowContinue)
	}
	return int64(f), p
}

func boolean(v any, fallback bool) (bool, result) {
	var p result
	switch x := v.(type) {
	case undefined:
		return fallback, p
	case bool:
		return x, p
	}
	p.invalidType("boolean", v)
	return false, p
}

// union is z.union(options).
func union[T any](v any, options ...func(any) (T, result)) (T, result) {
	var (
		zero       T
		nonAborted []result
		values     []T
	)
	for _, option := range options {
		value, p := option(v)
		if len(p.issues) == 0 {
			return value, p
		}
		if !p.aborted() {
			nonAborted = append(nonAborted, p)
			values = append(values, value)
		}
	}
	if len(nonAborted) == 1 {
		return values[0], nonAborted[0]
	}
	var p result
	p.add("invalid_union", "Invalid input", flowUnset)
	return zero, p
}

// condition is ConditionIn.
func condition(v any) (domain.Condition, result) {
	var (
		p result
		c domain.Condition
	)
	o, ok := object(v, &p)
	if !ok {
		return c, p
	}
	var child result
	c.Field, child = text(field(o, "field"), 60, false, true)
	p.merge("field", child)
	c.Op, child = enum(field(o, "op"), domain.ConditionOps)
	p.merge("op", child)
	if raw := field(o, "value"); raw != (undefined{}) {
		c.Value, child = text(raw, 200, false, false)
		p.merge("value", child)
	}
	return c, p
}

// step is RuleStepIn, a discriminated union on `kind`; the stored step names its fields as
// the TypeScript route's toInput does (minimumLevel, channelId).
func step(v any) (domain.Step, result) {
	var (
		p result
		s domain.Step
	)
	o, ok := object(v, &p)
	if !ok {
		return s, p
	}
	kind, _ := field(o, "kind").(string)
	var child result
	switch kind {
	case "evaluate":
		s.Kind = kind
		s.Title, child = text(field(o, "title"), 200, false, true)
		p.merge("title", child)
		s.MinimumLevel = "Media"
		if raw := field(o, "minimum_level"); raw != (undefined{}) {
			s.MinimumLevel, child = enum(raw, []string{"Media", "Alta"})
			p.merge("minimum_level", child)
		}
	case "notify":
		s.Kind = kind
		s.Title, child = text(field(o, "title"), 200, false, true)
		p.merge("title", child)
	case "channel":
		s.Kind = kind
		s.ChannelID, child = positiveInt(field(o, "channel_id"))
		p.merge("channel_id", child)
		s.Title, child = text(field(o, "title"), 200, false, true)
		p.merge("title", child)
	default:
		child.add("invalid_union", "Invalid discriminator value. Expected 'evaluate' | 'notify' | 'channel'", flowUnset)
		p.merge("kind", child)
	}
	return s, p
}

func ruleIn(v any) (domain.RuleInput, result) {
	var (
		p  result
		in domain.RuleInput
	)
	o, ok := object(v, &p)
	if !ok {
		return in, p
	}
	var child result
	in.Name, child = text(field(o, "name"), 80, true, true)
	p.merge("name", child)
	in.Enabled, child = boolean(field(o, "enabled"), true)
	p.merge("enabled", child)
	in.Module, child = text(field(o, "module"), 60, false, true)
	p.merge("module", child)
	in.Actions, child = array(field(o, "actions"), 1, 10, func(v any) (string, result) { return text(v, 20, false, false) })
	p.merge("actions", child)
	in.Conditions = []domain.Condition{}
	if raw := field(o, "conditions"); raw != (undefined{}) {
		in.Conditions, child = array(raw, -1, 10, condition)
		p.merge("conditions", child)
	}
	in.Steps, child = array(field(o, "steps"), 1, 5, step)
	p.merge("steps", child)
	return in, p
}

// channelInput is ChannelIn.
type channelInput struct {
	Kind     string
	Name     string
	Settings map[string]domain.Setting
}

func setting(v any) (domain.Setting, result) {
	return union(v,
		func(v any) (domain.Setting, result) {
			s, p := text(v, 1000, false, false)
			return domain.Setting{Text: s}, p
		},
		func(v any) (domain.Setting, result) {
			list, p := array(v, -1, 20, func(v any) (string, result) { return text(v, 200, false, false) })
			return domain.Setting{List: list, IsList: true}, p
		})
}

func channelIn(v any) (channelInput, result) {
	var (
		p  result
		in channelInput
	)
	o, ok := object(v, &p)
	if !ok {
		return in, p
	}
	var child result
	in.Kind, child = enum(field(o, "kind"), domain.ChannelKinds)
	p.merge("kind", child)
	in.Name, child = text(field(o, "name"), 80, true, true)
	p.merge("name", child)
	raw := field(o, "settings")
	settings, isObject := raw.(*records.Object)
	if !isObject {
		child = result{}
		child.invalidType("record", raw)
		p.merge("settings", child)
		return in, p
	}
	in.Settings = map[string]domain.Setting{}
	for _, key := range settings.Keys() {
		value, _ := settings.Get(key)
		s, child := setting(value)
		var keyed result
		keyed.merge(key, child)
		p.merge("settings", keyed)
		in.Settings[key] = s
	}
	return in, p
}

// readInput is NotificationReadIn: ids, or nil for { all: true }.
type readInput struct {
	IDs []int64
	All bool
}

func readIn(v any) (readInput, result) {
	return union(v,
		func(v any) (readInput, result) {
			var p result
			o, ok := object(v, &p)
			if !ok {
				return readInput{}, p
			}
			ids, child := array(field(o, "ids"), 1, 200, positiveInt)
			p.merge("ids", child)
			return readInput{IDs: ids}, p
		},
		func(v any) (readInput, result) {
			var p result
			o, ok := object(v, &p)
			if !ok {
				return readInput{}, p
			}
			if all := field(o, "all"); all != true {
				var child result
				child.add("invalid_value", "Invalid input: expected true", flowUnset)
				p.merge("all", child)
			}
			return readInput{All: true}, p
		})
}

// issue is one FastAPI/pydantic-style 422 item (ValidationIssue).
type issue struct {
	Type string `json:"type"`
	Loc  []any  `json:"loc"`
	Msg  string `json:"msg"`
}

var invalidJSON = []issue{{Type: "json_invalid", Loc: []any{"body"}, Msg: "JSON decode error"}}

// parse is parseJson(c, schema): JSON.parse of Hono's body text, then the schema; issues is
// nil when the body is valid. An invalid_type whose first path key is absent from the parsed
// body reads as pydantic's "missing".
func parse[T any](body []byte, schema func(any) (T, result)) (T, []issue) {
	var zero T
	v, err := records.Parse([]byte(httpx.JSONText(body)))
	if err != nil {
		return zero, invalidJSON
	}
	out, p := schema(v)
	if len(p.issues) == 0 {
		return out, nil
	}
	top, _ := v.(*records.Object)
	issues := make([]issue, 0, len(p.issues))
	for _, iss := range p.issues {
		item := issue{Type: iss.code, Loc: append([]any{"body"}, iss.path...), Msg: iss.message}
		if iss.code == "invalid_type" && len(iss.path) > 0 {
			key := ""
			switch k := iss.path[0].(type) {
			case string:
				key = k
			case int:
				key = strconv.Itoa(k)
			}
			present := false
			if top != nil {
				_, present = top.Get(key)
			}
			if !present {
				item.Type, item.Msg = "missing", "Field required"
			}
		}
		issues = append(issues, item)
	}
	return zero, issues
}

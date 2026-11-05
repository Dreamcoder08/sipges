//nolint:misspell // Spanish module names, verbatim from the TypeScript API.
package domain

import (
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	situations "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// Rules over the audit event stream: domain/rules.ts of the TypeScript context (docs/adr/0014
// §1-2). Pure: no I/O.

// AuditModule is AUTOMATION_AUDIT_MODULE: the audit module this context writes; its rows never
// trigger rules (no loops).
const AuditModule = "Automatizaciones"

// Rule limits of RULE_LIMITS.
const (
	limitConditions = 10
	limitSteps      = 5
	limitActions    = 10
	limitText       = 200
)

// MaxAttempts is MAX_ATTEMPTS.
const MaxAttempts = 5

// Condition is one rule condition; Value is ignored by `present` and `absent`.
type Condition struct {
	Field string `json:"field"`
	Op    string `json:"op"`
	Value string `json:"value"`
}

// Step is RuleAction as stored in automation_rules.actions: {kind, title} plus minimumLevel for
// `evaluate` and channelId for `channel`.
type Step struct {
	Kind         string `json:"kind"`
	Title        string `json:"title"`
	MinimumLevel string `json:"minimumLevel,omitempty"`
	ChannelID    int64  `json:"channelId,omitempty"`
}

// Rule is Rule of rules.ts.
type Rule struct {
	ID         int64
	Name       string
	Enabled    bool
	Module     string
	Actions    []string
	Conditions []Condition
	Steps      []Step
}

// EventRecord is the current state of the record an audit row names.
type EventRecord struct {
	// Payload is the decoded JSON payload (records/domain values, JavaScript key order).
	Payload any
	Marking string
}

// Event is AuditEvent: one audit row, with its record when there is one.
type Event struct {
	AuditID  int64
	At       time.Time // millisecond precision, as a JavaScript Date
	Module   string
	RecordID *string
	Action   string
	Detail   string
	Record   *EventRecord
}

// restricted is event.record?.marking === 'restringido'.
func (e Event) restricted() bool { return e.Record != nil && e.Record.Marking == "restringido" }

// field is event.record?.payload[name], own properties only (see ConditionHolds).
func (e Event) field(name string) (any, bool) {
	if e.Record == nil {
		return nil, false
	}
	if o, ok := e.Record.Payload.(*records.Object); ok {
		return o.Get(name)
	}
	return nil, false
}

// eventField is eventField of rules.ts. found is false where JavaScript reads undefined.
func eventField(e Event, name string) (any, bool) {
	switch name {
	case "$action":
		return e.Action, true
	case "$detail":
		return e.Detail, true
	case "$module":
		return e.Module, true
	case "$marking":
		if e.Record == nil {
			return nil, false
		}
		return e.Record.Marking, true
	}
	return e.field(name)
}

// normalize is normalize of rules.ts: ” for null and undefined, trimmed lower-case text for
// strings, String() for numbers and booleans, JSON.stringify for anything else, then
// toLocaleLowerCase('es') (the root mapping: Spanish has no tailoring).
func normalize(v any, found bool) string {
	if !found || v == nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return situations.LowerJS(situations.TrimJS(x))
	case float64:
		return situations.LowerJS(records.NumberString(x))
	case bool:
		return strconv.FormatBool(x)
	}
	return situations.LowerJS(string(records.Stringify(v)))
}

// compare is compare of rules.ts: numerically when both sides are finite numbers, else as text.
func compare(left, right string) int {
	a, aok := jsNumber(left)
	b, bok := jsNumber(right)
	if left != "" && right != "" && aok && bok && !math.IsInf(a, 0) && !math.IsInf(b, 0) {
		switch d := a - b; {
		case d < 0:
			return -1
		case d > 0:
			return 1
		}
		return 0
	}
	switch {
	case Less16(left, right):
		return -1
	case Less16(right, left):
		return 1
	}
	return 0
}

var decimalLiteral = regexp.MustCompile(`^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

// jsNumber is Number(text) (StringToNumber): ok is false where it gives NaN.
func jsNumber(s string) (float64, bool) {
	s = situations.TrimJS(s)
	if s == "" {
		return 0, true
	}
	switch s {
	case "Infinity", "+Infinity":
		return math.Inf(1), true
	case "-Infinity":
		return math.Inf(-1), true
	}
	if len(s) > 2 && s[0] == '0' {
		base := 0
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			return radixNumber(s[2:], base)
		}
	}
	if !decimalLiteral.MatchString(s) {
		return 0, false
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !math.IsInf(f, 0) && f != 0 {
		return 0, false
	}
	return f, true
}

// radixNumber reads digits of a 0x, 0o or 0b literal, rounding like JavaScript for long ones.
func radixNumber(digits string, base int) (float64, bool) {
	if digits == "" {
		return 0, false
	}
	f := 0.0
	for _, c := range digits {
		d := strings.IndexRune("0123456789abcdef", c|0x20)
		if c >= 'A' && c <= 'F' {
			d = int(c-'A') + 10
		}
		if d < 0 || d >= base {
			return 0, false
		}
		f = f*float64(base) + float64(d)
	}
	if u, err := strconv.ParseUint(digits, base, 64); err == nil {
		f = float64(u)
	}
	return f, true
}

// ConditionHolds is conditionHolds of rules.ts.
//
// One deliberate difference: a payload field is read as an own property only. JavaScript's
// `payload[field]` also reads Object.prototype, so a condition on `constructor` or `toString`
// throws in TypeScript (JSON.stringify of a function is undefined) and `__proto__` reads '{}';
// in Go such fields are absent.
func ConditionHolds(e Event, c Condition) bool {
	v, found := eventField(e, c.Field)
	actual := normalize(v, found)
	expected := normalize(c.Value, true)
	switch c.Op {
	case "present":
		return actual != ""
	case "absent":
		return actual == ""
	case "eq":
		return actual == expected
	case "neq":
		return actual != expected
	case "contains":
		return expected != "" && strings.Contains(actual, expected)
	case "gte":
		return actual != "" && compare(actual, expected) >= 0
	case "lte":
		return actual != "" && compare(actual, expected) <= 0
	}
	return false // unreachable: the operator was validated when the rule was saved
}

// RuleMatches is ruleMatches of rules.ts.
func RuleMatches(r Rule, e Event) bool {
	if !r.Enabled || e.Module == AuditModule || (r.Module != "*" && r.Module != e.Module) ||
		!slices.Contains(r.Actions, e.Action) {
		return false
	}
	for _, c := range r.Conditions {
		if !ConditionHolds(e, c) {
			return false
		}
	}
	return true
}

// RetryDelayMinutes is retryDelayMinutes: minutes to wait after the n-th failed attempt (1, 4,
// 16, 64), and false when the attempts are exhausted.
func RetryDelayMinutes(attempts int64) (int64, bool) {
	if attempts >= MaxAttempts {
		return 0, false
	}
	delay := int64(1)
	for range max(0, attempts-1) {
		delay *= 4
	}
	return delay, true
}

// NewRun is NewRun: one run per step of every rule an event matches.
type NewRun struct {
	RuleID      int64
	AuditID     int64
	ActionIndex int
	Kind        string
	Event       Event
}

// PlanRuns is planRuns of automation-service.ts.
func PlanRuns(events []Event, rules []Rule) []NewRun {
	var runs []NewRun
	for _, e := range events {
		for _, r := range rules {
			if !RuleMatches(r, e) {
				continue
			}
			for i, s := range r.Steps {
				runs = append(runs, NewRun{RuleID: r.ID, AuditID: e.AuditID, ActionIndex: i, Kind: s.Kind, Event: e})
			}
		}
	}
	return runs
}

// RenderTitle is renderTitle of rules.ts: `{Campo}` placeholders (1 to 60 UTF-16 units without
// braces) take values from the event, restricted records stay opaque, and the result is cut to
// 200 units. The result may end in a lone surrogate (WTF-8), as the JavaScript slice leaves it.
func RenderTitle(template string, e Event) string {
	u := Units(template)
	out := make([]uint16, 0, len(u))
	for i := 0; i < len(u); {
		if u[i] == '{' {
			if end, ok := placeholderEnd(u, i); ok {
				out = append(out, Units(placeholder(FromUnits(u[i+1:end]), e))...)
				i = end + 1
				continue
			}
		}
		out = append(out, u[i])
		i++
	}
	if len(out) > limitText {
		out = out[:limitText]
	}
	return FromUnits(out)
}

// placeholderEnd finds the `}` closing a placeholder that starts at u[start] == '{'.
func placeholderEnd(u []uint16, start int) (int, bool) {
	for j := start + 1; j < len(u) && j-start-1 <= 60; j++ {
		switch u[j] {
		case '{':
			return 0, false
		case '}':
			return j, j-start-1 >= 1
		}
	}
	return 0, false
}

func placeholder(name string, e Event) string {
	key := situations.TrimJS(name)
	switch key {
	case "modulo":
		return e.Module
	case "id":
		if e.RecordID == nil {
			return ""
		}
		return *e.RecordID
	case "accion":
		return e.Action
	}
	if e.restricted() {
		return "[restringido]"
	}
	v, found := e.field(key)
	if !found || v == nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return records.NumberString(x)
	case bool:
		return strconv.FormatBool(x)
	}
	return string(records.Stringify(v))
}

// DescribeEvent is describeEvent: one paragraph for channels and the inbox, cut to 500 units.
func DescribeEvent(e Event) string {
	subject := e.Module
	if e.RecordID != nil && *e.RecordID != "" {
		subject = e.Module + " " + *e.RecordID
	}
	detail := e.Detail
	if e.restricted() {
		detail = ""
	}
	text := e.Action + " en " + subject
	if detail != "" {
		text += ": " + detail
	}
	return Slice16(text, 500)
}

// RuleInput is RuleInput: a rule as the schema parsed it.
type RuleInput struct {
	Name       string
	Enabled    bool
	Module     string
	Actions    []string
	Conditions []Condition
	Steps      []Step
}

// RuleError is RuleError.
type RuleError string

// Rule errors, as validateRule names them.
const (
	InvalidModule    RuleError = "invalid_module"
	InvalidAction    RuleError = "invalid_action"
	InvalidCondition RuleError = "invalid_condition"
	InvalidStep      RuleError = "invalid_step"
)

var conditionField = regexp.MustCompile(`^\$?[\p{L}\p{N}_ /.\-]{1,60}$`)

// ValidateRule is validateRule: the rule against the known event sources and the tenant's
// channel ids. It returns "" when the rule is valid.
func ValidateRule(in RuleInput, known map[string]bool, channels map[int64]bool) RuleError {
	if in.Module != "*" && !known[in.Module] {
		return InvalidModule
	}
	if len(in.Actions) == 0 || len(in.Actions) > limitActions {
		return InvalidAction
	}
	for _, a := range in.Actions {
		if !slices.Contains(EventActions, a) {
			return InvalidAction
		}
	}
	if len(in.Conditions) > limitConditions {
		return InvalidCondition
	}
	for _, c := range in.Conditions {
		if !conditionField.MatchString(c.Field) || !slices.Contains(ConditionOps, c.Op) || Len16(c.Value) > limitText {
			return InvalidCondition
		}
	}
	if len(in.Steps) == 0 || len(in.Steps) > limitSteps {
		return InvalidStep
	}
	for _, s := range in.Steps {
		if Len16(situations.TrimJS(s.Title)) == 0 || Len16(s.Title) > limitText || !validStep(in, s, channels) {
			return InvalidStep
		}
	}
	return ""
}

func validStep(in RuleInput, s Step, channels map[int64]bool) bool {
	switch s.Kind {
	case "notify":
		return true
	case "evaluate":
		for _, a := range in.Actions {
			if a != "CREATE" && a != "UPDATE" {
				return false
			}
		}
		return in.Module == "Narrativas" && (s.MinimumLevel == "Media" || s.MinimumLevel == "Alta")
	case "channel":
		return channels[s.ChannelID]
	}
	return false
}

// KnownModules is the set of event sources a rule may name: sources().map(s => s.module).
func KnownModules() map[string]bool {
	out := map[string]bool{}
	for _, s := range Sources() {
		out[s.Module] = true
	}
	return out
}

// ISOMillis is Date.prototype.toISOString.
func ISOMillis(t time.Time) string {
	t = t.UTC()
	year := strconv.Itoa(t.Year())
	switch {
	case t.Year() < 0:
		year = "-" + leftPad(strconv.Itoa(-t.Year()), 6)
	case t.Year() > 9999:
		year = "+" + leftPad(year, 6)
	default:
		year = leftPad(year, 4)
	}
	return year + t.Format("-01-02T15:04:05.000") + "Z"
}

func leftPad(s string, n int) string {
	for len(s) < n {
		s = "0" + s
	}
	return s
}

// JSMillis truncates t to the millisecond, as a JavaScript Date holds it (towards -∞).
func JSMillis(t time.Time) time.Time {
	return time.UnixMilli(t.UnixMilli()).UTC()
}

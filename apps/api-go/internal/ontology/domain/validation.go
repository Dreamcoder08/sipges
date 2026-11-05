package domain

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// The bodies of the ontology write routes are validated as parseJson of
// apps/api/src/platform/http/validation.ts does with the Zod 4 schemas of @sipges/contracts
// (LinkIn, LinkEvidenceIn, MarkingIn, NeighbourhoodIn): the same issues, in the same order, with
// the same codes and English messages, mapped to the FastAPI-style 422 items of docs/adr/0007.
// Only the parts of Zod those four schemas use are ported, with the rules of zod 4.6:
//
//   - a schema's own parse runs first (type check, then an array's elements or an object's keys);
//   - its length checks (min, max) then run on any value that has a `length`, even after a type
//     error, and measure strings in code points;
//   - an array longer than its max reports only that, without reading its elements;
//   - a refinement runs only when nothing before it aborted (a length issue does not).
//
// testdata/validation.mjs records the TypeScript answers; validation_test.go pins this port to
// them.

// Issue is one FastAPI/pydantic-style validation error item (ValidationIssue).
type Issue struct {
	Type string `json:"type"`
	Loc  []any  `json:"loc"`
	Msg  string `json:"msg"`
}

// flow is a Zod issue's `continue`: unset aborts later checks without a `when` (refine); false
// also stops the length checks (an array's size cap); true lets every check run.
type flow int

const (
	flowUnset flow = iota
	flowContinue
	flowStop
)

type zodIssue struct {
	code    string
	path    []any
	message string
	flow    flow
}

// undefined is JavaScript's undefined: a key absent from the parsed body.
type undefined struct{}

// infinity is a JSON number JSON.parse reads as ±Infinity (1e400).
type infinity struct{ negative bool }

// ParseBody is c.req.json() as parseJson reads it: Request.json() decodes the bytes as WHATWG
// UTF-8 (one U+FFFD per maximal invalid subpart) and drops up to two leading byte order marks,
// then JSON.parse reads the whole text. ok is false when it throws (json_invalid). Numbers stay
// json.Number, or infinity where JSON.parse overflows.
func ParseBody(body []byte) (any, bool) {
	text := decodeUTF8(body)
	for range 2 {
		text = strings.TrimPrefix(text, "\ufeff")
	}
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, false
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, false // trailing data
	}
	return jsValue(v), true
}

// decodeUTF8 is the WHATWG UTF-8 decoder: each maximal subpart of an ill-formed sequence
// becomes one U+FFFD (Go's own decoding gives one per byte).
func decodeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var out strings.Builder
	for i := 0; i < len(b); {
		c := b[i]
		if c < 0x80 {
			out.WriteByte(c)
			i++
			continue
		}
		need, lo, hi := 0, byte(0x80), byte(0xbf)
		switch {
		case c >= 0xc2 && c <= 0xdf:
			need = 1
		case c == 0xe0:
			need, lo = 2, 0xa0
		case c >= 0xe1 && c <= 0xec, c == 0xee, c == 0xef:
			need = 2
		case c == 0xed:
			need, hi = 2, 0x9f
		case c == 0xf0:
			need, lo = 3, 0x90
		case c >= 0xf1 && c <= 0xf3:
			need = 3
		case c == 0xf4:
			need, hi = 3, 0x8f
		}
		j := i + 1
		for k := 0; need > 0 && k < need; k++ {
			if j >= len(b) || b[j] < lo || b[j] > hi {
				need = -1
				break
			}
			lo, hi = 0x80, 0xbf
			j++
		}
		if need <= 0 {
			out.WriteRune(utf8.RuneError)
			i = max(j, i+1)
			continue
		}
		out.Write(b[i:j])
		i = j
	}
	return out.String()
}

func jsValue(v any) any {
	switch x := v.(type) {
	case json.Number:
		if f, err := strconv.ParseFloat(string(x), 64); err != nil && math.IsInf(f, 0) {
			return infinity{negative: f < 0}
		}
		return x
	case map[string]any:
		for k, item := range x {
			x[k] = jsValue(item)
		}
		return x
	case []any:
		for i, item := range x {
			x[i] = jsValue(item)
		}
		return x
	default:
		return v
	}
}

// received is the type name of Zod's invalid_type message: util.parsedType, with ±Infinity
// spelled out as the English locale does.
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
	case json.Number:
		return "number"
	case infinity:
		if x.negative {
			return "-Infinity"
		}
		return "Infinity"
	case []any:
		return "array"
	default:
		return "object"
	}
}

// payload is one Zod parse: its issues, with paths relative to the schema being parsed.
type payload struct{ issues []zodIssue }

func (p *payload) add(code, message string, f flow, path ...any) {
	p.issues = append(p.issues, zodIssue{code: code, path: path, message: message, flow: f})
}

// aborted is util.aborted: any issue that is not explicitly continuable.
func (p *payload) aborted() bool {
	for _, iss := range p.issues {
		if iss.flow != flowContinue {
			return true
		}
	}
	return false
}

// explicitlyAborted is util.explicitlyAborted: any issue with continue === false.
func (p *payload) explicitlyAborted() bool {
	for _, iss := range p.issues {
		if iss.flow == flowStop {
			return true
		}
	}
	return false
}

// merge appends a child's issues under key, as Zod's prefixIssues does.
func (p *payload) merge(key any, child payload) {
	for _, iss := range child.issues {
		iss.path = append([]any{key}, iss.path...)
		p.issues = append(p.issues, iss)
	}
}

func (p *payload) invalidType(expected string, v any) {
	p.add("invalid_type", "Invalid input: expected "+expected+", received "+received(v), flowUnset)
}

// lengthOf is what the length checks read: `value.length` for any value that has one (strings
// in code points, arrays, objects with a "length" key) as a JavaScript number, and the origin
// that names it in the message. ok is false when the checks do not run (_whenHasLength).
func lengthOf(v any) (n float64, origin string, ok bool) {
	switch x := v.(type) {
	case string:
		return float64(utf8.RuneCountInString(x)), "string", true
	case []any:
		return float64(len(x)), "array", true
	case map[string]any:
		if l, has := x["length"]; has {
			return toNumber(l), "unknown", true
		}
	}
	return 0, "", false
}

// lengthChecks are .min(lo).max(hi) (lo < 0 or hi < 0 when absent); NaN fails both.
func (p *payload) lengthChecks(v any, lo, hi int) {
	if p.explicitlyAborted() {
		return
	}
	n, origin, ok := lengthOf(v)
	if !ok {
		return
	}
	unit := map[string]string{"string": "characters", "array": "items"}[origin]
	describe := func(adj string, bound int) string {
		if unit == "" {
			return "expected " + origin + " to be " + adj + strconv.Itoa(bound)
		}
		return "expected " + origin + " to have " + adj + strconv.Itoa(bound) + " " + unit
	}
	if lo >= 0 && !(n >= float64(lo)) {
		p.add("too_small", "Too small: "+describe(">=", lo), flowContinue)
	}
	if hi >= 0 && !(n <= float64(hi)) {
		p.add("too_big", "Too big: "+describe("<=", hi), flowContinue)
	}
}

var (
	jsDecimal = regexp.MustCompile(`^[+-]?(Infinity|[0-9]+\.?[0-9]*([eE][+-]?[0-9]+)?|\.[0-9]+([eE][+-]?[0-9]+)?)$`)
	jsRadix   = regexp.MustCompile(`^0([xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)$`)
)

func signedInf(negative bool) float64 {
	if negative {
		return math.Inf(-1)
	}
	return math.Inf(1)
}

// toNumber is JavaScript's ToNumber for a parsed JSON value (a relational comparison with a
// number), with arrays and objects through their string form.
func toNumber(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case json.Number:
		f, _ := strconv.ParseFloat(string(x), 64)
		return f
	case infinity:
		return signedInf(x.negative)
	case string:
		return stringToNumber(x)
	case []any:
		switch len(x) {
		case 0:
			return 0
		case 1:
			switch item := x[0].(type) {
			case nil:
				return 0
			case bool, map[string]any:
				return math.NaN() // "true", "false", "[object Object]"
			default:
				return toNumber(item)
			}
		}
		return math.NaN() // joined with ","
	default:
		return math.NaN() // "[object Object]"
	}
}

// stringToNumber is StringToNumber: JavaScript whitespace trimmed, empty is 0, decimal or
// 0x/0o/0b literals, anything else NaN.
func stringToNumber(s string) float64 {
	s = strings.TrimFunc(s, js.IsJSSpace)
	switch {
	case s == "":
		return 0
	case jsRadix.MatchString(s):
		base := map[byte]int{'x': 16, 'o': 8, 'b': 2}[s[1]|0x20]
		n, _ := new(big.Int).SetString(s[2:], base)
		f, _ := new(big.Float).SetInt(n).Float64()
		return f
	case jsDecimal.MatchString(s):
		if strings.HasSuffix(s, "Infinity") {
			return signedInf(s[0] == '-')
		}
		f, _ := strconv.ParseFloat(s, 64) // out of range is ±Inf or 0, as in JavaScript
		return f
	}
	return math.NaN()
}

// zodString is z.string() with .min(lo).max(hi) (negative when absent), plus .refine(no NUL)
// when noNUL.
func zodString(v any, lo, hi int, noNUL bool) (string, payload) {
	var p payload
	s, ok := v.(string)
	if !ok {
		p.invalidType("string", v)
	}
	p.lengthChecks(v, lo, hi)
	if noNUL && !p.aborted() && strings.ContainsRune(s, 0) {
		p.add("custom", "Text must not contain NUL characters", flowContinue)
	}
	return s, p
}

// zodArray is z.array(item) with .min(lo).max(hi) (negative when absent).
func zodArray[T any](v any, lo, hi int, item func(any) (T, payload)) ([]T, payload) {
	var p payload
	list, ok := v.([]any)
	switch {
	case !ok:
		p.invalidType("array", v)
	case hi >= 0 && len(list) > hi:
		// capSize: the size cap is checked before the elements are read, and stops there.
		p.add("too_big", "Too big: expected array to have <="+strconv.Itoa(hi)+" items", flowStop)
		return nil, p
	}
	out := make([]T, 0, len(list))
	for i, element := range list {
		value, child := item(element)
		p.merge(i, child)
		out = append(out, value)
	}
	p.lengthChecks(v, lo, hi)
	return out, p
}

// field reads key of a JSON object: undefined when absent.
func field(m map[string]any, key string) any {
	if v, ok := m[key]; ok {
		return v
	}
	return undefined{}
}

// object is the type check of z.object: a JSON object (not null, not an array). Unknown keys
// are dropped.
func object(v any, p *payload) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	if !ok {
		p.invalidType("object", v)
	}
	return m, ok
}

// Ref is RecordRef of @sipges/contracts: { module, id } with a slug as module.
type Ref struct {
	Module string `json:"module"`
	ID     string `json:"id"`
}

// recordRef is RecordRef: module 1–40 characters, id 1–200 without NUL.
func recordRef(v any) (Ref, payload) {
	var p payload
	m, ok := object(v, &p)
	if !ok {
		return Ref{}, p
	}
	module, child := zodString(field(m, "module"), 1, 40, false)
	p.merge("module", child)
	id, child := zodString(field(m, "id"), 1, 200, true)
	p.merge("id", child)
	return Ref{module, id}, p
}

// evidenceRef is EvidenceRef (RecordRef with module the literal 'fuentes') made nullable.
func evidenceRef(v any) (*Ref, payload) {
	var p payload
	if v == nil {
		return nil, p
	}
	m, ok := object(v, &p)
	if !ok {
		return nil, p
	}
	if field(m, "module") != "fuentes" {
		p.add("invalid_value", `Invalid input: expected "fuentes"`, flowUnset, "module")
	}
	id, child := zodString(field(m, "id"), 1, 200, true)
	p.merge("id", child)
	return &Ref{"fuentes", id}, p
}

// LinkInput is LinkIn: POST /system/links.
type LinkInput struct {
	LinkType string
	Source   Ref
	Target   Ref
	Note     string
	Evidence *Ref
}

// EvidenceInput is LinkEvidenceIn: PUT /system/links/:id/evidence.
type EvidenceInput struct{ Evidence *Ref }

// MarkingInput is MarkingIn: PUT /system/marking.
type MarkingInput struct{ Module, ID, Marking string }

// NeighbourhoodInput is NeighbourhoodIn: POST /system/graph/neighbourhood.
type NeighbourhoodInput struct {
	Seeds  []Ref
	Hops   [][]string
	Fields []string
}

func linkIn(v any) (LinkInput, payload) {
	var (
		p   payload
		out LinkInput
	)
	m, ok := object(v, &p)
	if !ok {
		return out, p
	}
	var child payload
	out.LinkType, child = zodString(field(m, "link_type"), 1, 40, false)
	p.merge("link_type", child)
	out.Source, child = recordRef(field(m, "source"))
	p.merge("source", child)
	out.Target, child = recordRef(field(m, "target"))
	p.merge("target", child)
	if note, present := m["note"]; present { // .default('') when absent
		out.Note, child = zodString(note, -1, 500, false)
		p.merge("note", child)
	}
	if evidence, present := m["evidence"]; present { // .optional()
		out.Evidence, child = evidenceRef(evidence)
		p.merge("evidence", child)
	}
	return out, p
}

func evidenceIn(v any) (EvidenceInput, payload) {
	var (
		p   payload
		out EvidenceInput
	)
	m, ok := object(v, &p)
	if !ok {
		return out, p
	}
	var child payload
	out.Evidence, child = evidenceRef(field(m, "evidence"))
	p.merge("evidence", child)
	return out, p
}

// Markings are the values of the marking column (docs/adr/0012).
var Markings = []string{"publico", "interno", "restringido"}

// IsMarking is isMarking.
func IsMarking(v string) bool {
	for _, m := range Markings {
		if m == v {
			return true
		}
	}
	return false
}

func markingIn(v any) (MarkingInput, payload) {
	var (
		p   payload
		out MarkingInput
	)
	m, ok := object(v, &p)
	if !ok {
		return out, p
	}
	var child payload
	out.Module, child = zodString(field(m, "module"), 1, 40, false)
	p.merge("module", child)
	out.ID, child = zodString(field(m, "id"), 1, 200, false)
	p.merge("id", child)
	marking, _ := field(m, "marking").(string)
	if !IsMarking(marking) {
		p.add("invalid_value", `Invalid option: expected one of "publico"|"interno"|"restringido"`, flowUnset, "marking")
	}
	out.Marking = marking
	return out, p
}

func hopTypes(v any) ([]string, payload) {
	return zodArray(v, 1, 20, func(v any) (string, payload) { return zodString(v, 1, 40, false) })
}

func fieldName(v any) (string, payload) { return zodString(v, 1, 60, false) }

func neighbourhoodIn(v any) (NeighbourhoodInput, payload) {
	var (
		p   payload
		out NeighbourhoodInput
	)
	m, ok := object(v, &p)
	if !ok {
		return out, p
	}
	var child payload
	out.Seeds, child = zodArray(field(m, "seeds"), 1, 100, recordRef)
	p.merge("seeds", child)
	out.Hops, child = zodArray(field(m, "hops"), 1, 2, hopTypes)
	p.merge("hops", child)
	out.Fields = []string{}
	if fields, present := m["fields"]; present { // .default([]) when absent
		out.Fields, child = zodArray(fields, -1, 24, fieldName)
		p.merge("fields", child)
	}
	return out, p
}

// toIssues is toIssues of validation.ts: an invalid_type whose first path key is absent from
// the parsed body reads as pydantic's "missing".
func toIssues(p payload, input any) []Issue {
	top, _ := input.(map[string]any)
	out := make([]Issue, 0, len(p.issues))
	for _, iss := range p.issues {
		item := Issue{Type: iss.code, Loc: append([]any{"body"}, iss.path...), Msg: iss.message}
		if iss.code == "invalid_type" && len(iss.path) > 0 {
			key, _ := iss.path[0].(string)
			if _, present := top[key]; top == nil || !present {
				item.Type, item.Msg = "missing", "Field required"
			}
		}
		out = append(out, item)
	}
	return out
}

// InvalidJSON is the 422 detail of a body JSON.parse refuses.
var InvalidJSON = []Issue{{Type: "json_invalid", Loc: []any{"body"}, Msg: "JSON decode error"}}

func validate[T any](body []byte, schema func(any) (T, payload)) (T, []Issue) {
	v, ok := ParseBody(body)
	if !ok {
		var zero T
		return zero, InvalidJSON
	}
	out, p := schema(v)
	if len(p.issues) > 0 {
		return out, toIssues(p, v)
	}
	return out, nil
}

// ParseLinkIn validates a POST /system/links body; issues is nil when it is valid.
func ParseLinkIn(body []byte) (LinkInput, []Issue) { return validate(body, linkIn) }

// ParseEvidenceIn validates a PUT /system/links/:id/evidence body.
func ParseEvidenceIn(body []byte) (EvidenceInput, []Issue) { return validate(body, evidenceIn) }

// ParseMarkingIn validates a PUT /system/marking body.
func ParseMarkingIn(body []byte) (MarkingInput, []Issue) { return validate(body, markingIn) }

// ParseNeighbourhoodIn validates a POST /system/graph/neighbourhood body.
func ParseNeighbourhoodIn(body []byte) (NeighbourhoodInput, []Issue) {
	return validate(body, neighbourhoodIn)
}

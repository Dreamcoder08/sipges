package domain

import (
	"bytes"
	"encoding/json"
	"math"
	"slices"

	situations "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// Records as the egress guard releases them: allowed fields only, names replaced. Pure. Port of
// sanitise.ts.

// RawField is one field of a record in the order the object holds it. Value is what decoding the
// JSON payload gives: nil, bool, string, json.Number, float64, or anything else (never sent).
type RawField struct {
	Name  string
	Value any
}

// RawRecord is a record as the owning context holds it, before the guard looks at it.
type RawRecord struct {
	// Module is the module slug (actores, eventos...).
	Module string
	ID     string
	// Title is the record's display title: the value of its module's title field, or the id.
	Title *string
	Date  *string
	// Marking is the classification (ADR 0012). Anything but a known open marking is withheld.
	Marking *string
	// Fields must not repeat a name, as an object cannot.
	Fields []RawField
}

// Value is a sanitised field value: a string or a number.
type Value struct {
	Text     string
	Number   float64
	IsNumber bool
}

// MarshalJSON writes the string or the number as JSON.stringify does.
func (v Value) MarshalJSON() ([]byte, error) {
	if v.IsNumber {
		return []byte(situations.JSNumber(v.Number)), nil
	}
	return Text(v.Text).MarshalJSON()
}

// Field is one sanitised field.
type Field struct {
	Name  string
	Value Value
}

// Fields are sanitised fields; they marshal as an object in their order.
type Fields []Field

// MarshalJSON writes the fields as one object, in order.
func (f Fields) MarshalJSON() ([]byte, error) {
	var out bytes.Buffer
	out.WriteByte('{')
	for i, field := range f {
		if i > 0 {
			out.WriteByte(',')
		}
		key, err := Text(field.Name).MarshalJSON()
		if err != nil {
			return nil, err
		}
		value, err := field.Value.MarshalJSON()
		if err != nil {
			return nil, err
		}
		out.Write(key)
		out.WriteByte(':')
		out.Write(value)
	}
	out.WriteByte('}')
	return out.Bytes(), nil
}

// MapStrings is a copy with every string value through fn; names are object keys and stay.
func (f Fields) MapStrings(fn func(string) string) Fields {
	if f == nil {
		return nil
	}
	out := slices.Clone(f)
	for i := range out {
		if !out[i].Value.IsNumber {
			out[i].Value.Text = fn(out[i].Value.Text)
		}
	}
	return out
}

// SanitisedRecord is what may leave of a record.
type SanitisedRecord struct {
	Module  string  `json:"module"`
	ID      Text    `json:"id"`
	Title   *Text   `json:"title"`
	Date    *Text   `json:"date"`
	Marking *string `json:"marking"`
	// Withheld: restricted (or unclassified) records are withheld whole, no title, no fields.
	Withheld bool   `json:"withheld"`
	Fields   Fields `json:"fields"`
}

// EgressReport is what the access log keeps of a release: ids and counts, never values.
type EgressReport struct {
	Records []string
	Sent    int
	Dropped int
	// Withheld are the records kept back whole because they are restricted; ids only.
	Withheld      []string
	DroppedFields []string
}

const restricted = "restringido"

// isOpenMarking: the only markings that may leave; restringido and anything unknown never do.
func isOpenMarking(marking *string) bool {
	return marking != nil && (*marking == "publico" || *marking == "interno")
}

// scalar is the value as a string or number that can be sent, or false.
func scalar(value any) (Value, bool) {
	switch v := value.(type) {
	case float64:
		return Value{Number: v, IsNumber: true}, !math.IsInf(v, 0) && !math.IsNaN(v)
	case json.Number:
		return scalar(situations.Float(v))
	case bool:
		if v {
			return Value{Text: "true"}, true
		}
		return Value{Text: "false"}, true
	case string:
		trimmed := situations.TrimJS(v)
		return Value{Text: trimmed}, trimmed != ""
	}
	return Value{}, false
}

// isBlank is the check for a field with nothing in it: null, undefined or ”.
func isBlank(value any) bool { return value == nil || value == "" }

func (v Value) string() string {
	if v.IsNumber {
		return situations.JSNumber(v.Number)
	}
	return v.Text
}

// treat is one field value under its policy; false when nothing is left to send.
func treat(p *Pseudonymiser, policy FieldPolicy, value Value) (Value, bool) {
	entity := policy.Entity
	if entity == "" {
		entity = Persona
	}
	pseudonymOf := func(raw string) string {
		kind, ok := p.KindOf(raw)
		if !ok {
			kind = entity
		}
		return p.Pseudonym(kind, raw)
	}
	switch policy.Kind {
	case PolicyName:
		return Value{Text: pseudonymOf(value.string())}, true
	case PolicyNames:
		var joined []byte
		for _, item := range SplitList(value.string()) {
			if item = situations.TrimJS(item); item == "" {
				continue
			}
			if len(joined) > 0 {
				joined = append(joined, ", "...)
			}
			joined = append(joined, pseudonymOf(item)...)
		}
		return Value{Text: string(joined)}, len(joined) > 0
	default:
		if value.IsNumber {
			return value, true
		}
		clean := p.Scrub(value.Text)
		return Value{Text: clean}, clean != ""
	}
}

func scrubbedText(p *Pseudonymiser, value *string) *Text {
	if value == nil || *value == "" {
		return nil
	}
	trimmed, ok := scalar(*value)
	if !ok {
		return nil
	}
	clean := Text(p.Scrub(trimmed.Text))
	return &clean
}

func title(p *Pseudonymiser, record RawRecord) *Text {
	if record.Title == nil || *record.Title == "" {
		return nil
	}
	policy, ok := PolicyFor(record.Module, TitleFields[record.Module])
	if !ok {
		return nil
	}
	raw, ok := scalar(*record.Title)
	if !ok {
		return nil
	}
	treated, ok := treat(p, policy, raw)
	if !ok {
		return nil
	}
	clean := Text(treated.Text)
	return &clean
}

func withhold(p *Pseudonymiser, record RawRecord) SanitisedRecord {
	out := SanitisedRecord{Module: record.Module, ID: Text(p.Scrub(record.ID)), Withheld: true, Fields: Fields{}}
	if record.Marking != nil && *record.Marking == restricted {
		marking := restricted
		out.Marking = &marking
	}
	return out
}

// SanitiseRecords keeps the allowed fields of records, with names replaced, and withholds the
// ones that may not leave.
func SanitiseRecords(p *Pseudonymiser, records []RawRecord) ([]SanitisedRecord, EgressReport) {
	report := EgressReport{Records: make([]string, 0, len(records)), Withheld: []string{}}
	dropped := map[string]struct{}{}
	sanitised := make([]SanitisedRecord, 0, len(records))
	for _, record := range records {
		ref := record.Module + "/" + record.ID
		report.Records = append(report.Records, ref)
		if !isOpenMarking(record.Marking) {
			report.Withheld = append(report.Withheld, ref)
			for _, field := range record.Fields {
				if !isBlank(field.Value) {
					report.Dropped++
				}
			}
			sanitised = append(sanitised, withhold(p, record))
			continue
		}
		fields := Fields{}
		for _, field := range record.Fields {
			if isBlank(field.Value) {
				continue
			}
			policy, allowed := PolicyFor(record.Module, field.Name)
			value, ok := scalar(field.Value)
			if !allowed || !ok {
				report.Dropped++
				dropped[field.Name] = struct{}{}
				continue
			}
			if treated, ok := treat(p, policy, value); ok {
				fields = append(fields, Field{field.Name, treated})
				report.Sent++
			}
		}
		marking := *record.Marking
		sanitised = append(sanitised, SanitisedRecord{
			Module: record.Module, ID: Text(p.Scrub(record.ID)), Title: title(p, record),
			Date: scrubbedText(p, record.Date), Marking: &marking, Fields: fields,
		})
	}
	report.DroppedFields = sortedFields(dropped)
	return sanitised, report
}

// sortedFields is [...set].sort(): by UTF-16 code unit.
func sortedFields(set map[string]struct{}) []string {
	out := make([]string, 0, len(set))
	for field := range set {
		out = append(out, field)
	}
	slices.SortFunc(out, func(a, b string) int { return slices.Compare(toUnits(a), toUnits(b)) })
	return out
}

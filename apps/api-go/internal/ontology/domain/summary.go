package domain

import (
	"bytes"
	"encoding/json"
	"slices"

	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// textOf is text() of ontology-service.ts: String(value).trim() for strings, numbers and
// booleans, else "".
func textOf(v any) string {
	switch v.(type) {
	case string, json.Number, bool:
		return js.TrimJS(js.JSString(v))
	}
	return ""
}

// TitleOf is titleOf: the title field (string or number), trimmed and cut to 140 code units
// with an ellipsis, else the id.
func TitleOf(t ObjectType, id string, payload Payload) Text {
	text := ""
	if v, ok := scalarText(payload[t.TitleField]); ok {
		text = js.TrimJS(v)
	}
	if text == "" {
		return Text(id)
	}
	units := UnitsOf(text)
	if len(units) > 140 {
		return append(slices.Clone(units[:139]), '…').Text()
	}
	return Text(text)
}

// Field is one summary field.
type Field struct{ Name, Value string }

// Fields keeps the catalog's field order when marshalled, as Object.fromEntries does.
type Fields []Field

// MarshalJSON writes the fields as one object, in order.
func (f Fields) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, field := range f {
		if i > 0 {
			b.WriteByte(',')
		}
		name, err := json.Marshal(field.Name)
		if err != nil {
			return nil, err
		}
		value, err := json.Marshal(field.Value)
		if err != nil {
			return nil, err
		}
		b.Write(name)
		b.WriteByte(':')
		b.Write(value)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// Summary is ObjectSummary as the routes write it (summaryOut of ontology-routes.ts).
type Summary struct {
	Module    string  `json:"module"`
	ID        string  `json:"id"`
	TypeLabel string  `json:"type_label"`
	Title     Text    `json:"title"`
	Date      *string `json:"date"`
	Marking   string  `json:"marking"`
	Fields    Fields  `json:"fields"`
}

// Summarize is summarize: title, own date and the non-empty summary fields (plus extra ones).
func Summarize(t ObjectType, id string, payload Payload, marking string, extra []string) Summary {
	s := Summary{Module: t.Slug, ID: id, TypeLabel: t.Label, Title: TitleOf(t, id, payload), Marking: marking, Fields: Fields{}}
	if t.DateField != "" {
		if date := textOf(payload[t.DateField]); date != "" {
			s.Date = &date
		}
	}
	names := []string{}
	for _, name := range append(slices.Clone(t.SummaryFields), extra...) {
		if !slices.Contains(names, name) {
			names = append(names, name)
		}
	}
	for _, name := range names {
		if value := textOf(payload[name]); value != "" {
			s.Fields = append(s.Fields, Field{name, value})
		}
	}
	return s
}

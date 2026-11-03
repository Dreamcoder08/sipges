package domain

import (
	"bytes"
	"slices"
)

// FieldChange is FieldChange of history.ts; a nil Before or After pointer is a missing field
// (undefined, which JSON.stringify leaves out).
type FieldChange struct {
	Field  string
	Before *any
	After  *any
}

// property is `payload[field]` in JavaScript: an own property, or what an ordinary object
// inherits. Of Object.prototype's names only __proto__ has a JSON form (Object.prototype itself,
// written {}); its methods are functions, which JSON.stringify treats as missing.
func property(payload *Object, field string) *any {
	if payload != nil {
		if v, ok := payload.Get(field); ok {
			return &v
		}
	}
	if field == "__proto__" {
		var prototype any = NewObject()
		return &prototype
	}
	return nil
}

// same is `JSON.stringify(a) === JSON.stringify(b)`.
func same(a, b *any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return bytes.Equal(Stringify(*a), Stringify(*b))
}

// DiffPayloads is diffPayloads: the fields that differ between two versions (nil is a
// deletion), sorted by field name in UTF-16 order.
func DiffPayloads(before, after *Object) []FieldChange {
	var fields []string
	seen := map[string]bool{}
	for _, o := range []*Object{before, after} {
		if o == nil {
			continue
		}
		for _, k := range o.Keys() {
			if !seen[k] {
				seen[k] = true
				fields = append(fields, k)
			}
		}
	}
	slices.SortStableFunc(fields, less16)
	changes := []FieldChange{}
	for _, f := range fields {
		b, a := property(before, f), property(after, f)
		if !same(b, a) {
			changes = append(changes, FieldChange{Field: f, Before: b, After: a})
		}
	}
	return changes
}

// AppendChanges writes changes as JSON.stringify writes the FieldChange list.
func AppendChanges(b []byte, changes []FieldChange) []byte {
	b = append(b, '[')
	for i, c := range changes {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"field":`...)
		b = appendString(b, c.Field)
		if c.Before != nil {
			b = append(b, `,"before":`...)
			b = appendJSON(b, *c.Before)
		}
		if c.After != nil {
			b = append(b, `,"after":`...)
			b = appendJSON(b, *c.After)
		}
		b = append(b, '}')
	}
	return append(b, ']')
}

// AppendSummary writes s as JSON.stringify writes a RecordSummary.
func AppendSummary(b []byte, s RecordSummary) []byte {
	b = append(b, `{"slug":`...)
	b = appendString(b, s.Slug)
	b = append(b, `,"id":`...)
	b = appendString(b, s.ID)
	b = append(b, `,"title":`...)
	b = appendString(b, s.Title)
	b = append(b, `,"territory":`...)
	b = appendString(b, s.Territory)
	b = append(b, `,"date":`...)
	b = appendString(b, s.Date)
	b = append(b, `,"verification":`...)
	if s.Verification == nil {
		b = append(b, "null"...)
	} else {
		b = appendString(b, *s.Verification)
	}
	b = append(b, `,"validation":`...)
	b = appendString(b, s.Validation)
	return append(b, '}')
}

// AppendString writes s as JSON.stringify does.
func AppendString(b []byte, s string) []byte { return appendString(b, s) }

// AppendJSON writes a decoded value as JSON.stringify does.
func AppendJSON(b []byte, v any) []byte { return appendJSON(b, v) }

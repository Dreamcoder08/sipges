package application

import (
	"cmp"
	"context"
	"slices"
	"strings"

	ontology "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
	sanitised "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
	situations "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// count_records (odd/tasks/reporting-mcp.md S3, S4): the records of one module, optionally grouped
// by a field whose allowlist policy is `clear` and bounded by dates on the module's date field. Every
// record read passes through the guard's session, which also logs it; withheld ones are not counted.
// The count never runs in SQL, where it would see restricted records and could key on a name.

const (
	unknownModule = "Módulo no válido"
	noDateField   = "El tipo de objeto %s no tiene campo de fecha"
	notGroupable  = "No se puede agrupar por «%s»: solo campos de lista cerrada, códigos, fechas o números"
)

type countGroupJSON struct {
	Value *sanitised.Value `json:"value"`
	Count int              `json:"count"`
}

type countJSON struct {
	Module    string           `json:"module"`
	GroupBy   *string          `json:"group_by"`
	From      *string          `json:"from"`
	To        *string          `json:"to"`
	Total     int              `json:"total"`
	Truncated bool             `json:"truncated"`
	Groups    []countGroupJSON `json:"groups"`
}

// nonEmpty is nil for "", else a pointer to s.
func nonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (c readCall) count(ctx context.Context) (any, string, error) {
	slug, field, fromRaw, toRaw := c.text("module"), c.text("group_by"), c.text("from"), c.text("to")
	t, known := ontology.ObjectTypeForSlug(slug)
	if !known {
		return nil, unknownModule, nil
	}
	from, okFrom := ontology.DayBound(fromRaw, false)
	to, okTo := ontology.DayBound(toRaw, true)
	if !okFrom || !okTo {
		return nil, invalidDates, nil
	}
	dated := fromRaw != "" || toRaw != ""
	if dated && t.DateField == "" {
		return nil, strings.Replace(noDateField, "%s", slug, 1), nil
	}
	if field != "" {
		if policy, ok := sanitised.PolicyFor(slug, field); !ok || policy.Kind != sanitised.PolicyClear {
			return nil, strings.Replace(notGroupable, "%s", field, 1), nil
		}
	}
	found, err := c.Ontology.Countable(ctx, c.tenant, t, field, dated, from, to)
	if err != nil {
		return nil, "", err
	}
	raw := make([]sanitised.RawRecord, len(found.Rows))
	for i, row := range found.Rows {
		title, marking := "", row.Marking
		fields := []sanitised.RawField{}
		if field != "" {
			fields = append(fields, sanitised.RawField{Name: field, Value: row.Value})
		}
		raw[i] = sanitised.RawRecord{Module: slug, ID: row.ID, Title: &title, Marking: &marking, Fields: fields}
	}
	out := countJSON{Module: slug, GroupBy: nonEmpty(field), Truncated: found.Truncated, Groups: []countGroupJSON{}}
	if fromRaw != "" {
		out.From = &from
	}
	if toRaw != "" {
		out.To = &to
	}
	groups := map[groupKey]int{}
	for _, record := range c.session.Records(raw) {
		if record.Withheld {
			continue
		}
		out.Total++
		if field != "" {
			groups[groupOf(record.Fields, field)]++
		}
	}
	for key, count := range groups {
		out.Groups = append(out.Groups, countGroupJSON{Value: key.value(), Count: count})
	}
	slices.SortFunc(out.Groups, compareGroups)
	return out, "", nil
}

// groupKey is a group's sanitised value; null when the field was missing or left nothing to send.
type groupKey struct {
	null     bool
	isNumber bool
	text     string
	number   float64
}

func groupOf(fields sanitised.Fields, name string) groupKey {
	for _, f := range fields {
		if f.Name == name {
			return groupKey{isNumber: f.Value.IsNumber, text: f.Value.Text, number: f.Value.Number}
		}
	}
	return groupKey{null: true}
}

func (k groupKey) value() *sanitised.Value {
	if k.null {
		return nil
	}
	return &sanitised.Value{Text: k.text, Number: k.number, IsNumber: k.isNumber}
}

// asText is the value as text, as String(value) gives it.
func (k groupKey) asText() string {
	if k.isNumber {
		return situations.JSNumber(k.number)
	}
	return k.text
}

// compareGroups: count descending, then value ascending as text, null last.
func compareGroups(a, b countGroupJSON) int {
	if n := cmp.Compare(b.Count, a.Count); n != 0 {
		return n
	}
	switch {
	case a.Value == nil && b.Value == nil:
		return 0
	case a.Value == nil:
		return 1
	case b.Value == nil:
		return -1
	}
	ka := groupKey{isNumber: a.Value.IsNumber, text: a.Value.Text, number: a.Value.Number}
	kb := groupKey{isNumber: b.Value.IsNumber, text: b.Value.Text, number: b.Value.Number}
	if n := cmp.Compare(ka.asText(), kb.asText()); n != 0 {
		return n
	}
	// 1 and "1" read the same as text: the number first, so the order never depends on a map.
	switch {
	case ka.isNumber == kb.isNumber:
		return 0
	case ka.isNumber:
		return -1
	}
	return 1
}

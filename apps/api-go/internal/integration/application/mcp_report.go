package application

import (
	"cmp"
	"context"
	"slices"
	"strings"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	ontology "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
	sanitised "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
)

// report_period (odd/tasks/reporting-mcp.md S7–S9): count_records with the period said in words,
// resolved to Lima days here, and a series by day or month on the module's date field. Like
// count_records it counts in code what the guard's session lets through, never in SQL.

const (
	invalidPeriod   = "Período no válido: use " + domain.PeriodWords
	periodAndDates  = "Use un período o fechas, no ambos"
	groupAndSeries  = "Use group_by o by, no ambos"
	invalidSeries   = "by debe ser «dia» o «mes»"
	invalidFormat   = "format debe ser «json» o «csv»"
	reportAllDays   = "9999-12-31"
	reportFirstDays = "0000-01-01"
)

type reportPeriodJSON struct {
	Label string `json:"label"`
	From  string `json:"from"`
	To    string `json:"to"`
}

type reportPointJSON struct {
	Period string `json:"period"`
	Count  int    `json:"count"`
}

type reportJSON struct {
	Module    string            `json:"module"`
	Period    *reportPeriodJSON `json:"period"`
	GroupBy   *string           `json:"group_by"`
	By        *string           `json:"by"`
	Total     int               `json:"total"`
	Truncated bool              `json:"truncated"`
	Groups    []countGroupJSON  `json:"groups"`
	Series    []reportPointJSON `json:"series"`
	CSV       *string           `json:"csv,omitempty"`
}

// seriesLength is how much of an ISO date names a point: the day, or the month.
var seriesLength = map[string]int{"dia": 10, "mes": 7}

func (c readCall) report(ctx context.Context) (any, string, error) {
	slug := c.text("module")
	words := domain.TrimJS(c.text("period"))
	fromRaw, toRaw := domain.TrimJS(c.text("from")), domain.TrimJS(c.text("to"))
	field := domain.TrimJS(c.text("group_by"))
	by := domain.Fold(domain.TrimJS(c.text("by")))
	format := domain.Fold(domain.TrimJS(c.text("format")))
	t, known := ontology.ObjectTypeForSlug(slug)
	switch {
	case !known:
		return nil, unknownModule, nil
	case format != "json" && format != "csv":
		return nil, invalidFormat, nil
	case words != "" && (fromRaw != "" || toRaw != ""):
		return nil, periodAndDates, nil
	case field != "" && by != "":
		return nil, groupAndSeries, nil
	}
	if _, ok := seriesLength[by]; by != "" && !ok {
		return nil, invalidSeries, nil
	}
	period, refusal := c.period(words, fromRaw, toRaw)
	if refusal != "" {
		return nil, refusal, nil
	}
	if (period != nil || by != "") && t.DateField == "" {
		return nil, strings.Replace(noDateField, "%s", slug, 1), nil
	}
	if field != "" {
		if policy, ok := sanitised.PolicyFor(slug, field); !ok || policy.Kind != sanitised.PolicyClear {
			return nil, strings.Replace(notGroupable, "%s", field, 1), nil
		}
	}
	// A series reads the date field and, bounded or not, only records whose date is an ISO day.
	read, from, to := field, reportFirstDays, reportAllDays
	if by != "" {
		read = t.DateField
	}
	if period != nil {
		from, to = period.From, period.To
	}
	found, err := c.Ontology.Countable(ctx, c.tenant, t, read, period != nil || by != "", from, to)
	if err != nil {
		return nil, "", err
	}
	raw := make([]sanitised.RawRecord, len(found.Rows))
	for i, row := range found.Rows {
		title, marking := "", row.Marking
		fields := []sanitised.RawField{}
		if read != "" {
			fields = append(fields, sanitised.RawField{Name: read, Value: row.Value})
		}
		raw[i] = sanitised.RawRecord{Module: slug, ID: row.ID, Title: &title, Marking: &marking, Fields: fields}
	}
	out := reportJSON{Module: slug, Period: period, GroupBy: nonEmpty(field), By: nonEmpty(by),
		Truncated: found.Truncated, Groups: []countGroupJSON{}, Series: []reportPointJSON{}}
	groups, points := map[groupKey]int{}, map[string]int{}
	for _, record := range c.session.Records(raw) {
		if record.Withheld {
			continue
		}
		out.Total++
		switch {
		case field != "":
			groups[groupOf(record.Fields, field)]++
		case by != "":
			// The read keeps only ISO days; a value the guard emptied still counts, as no day.
			point := groupOf(record.Fields, read).asText()
			if len(point) >= seriesLength[by] {
				point = point[:seriesLength[by]]
			}
			points[point]++
		}
	}
	for key, count := range groups {
		out.Groups = append(out.Groups, countGroupJSON{Value: key.value(), Count: count})
	}
	slices.SortFunc(out.Groups, compareGroups)
	for point, count := range points {
		out.Series = append(out.Series, reportPointJSON{Period: point, Count: count})
	}
	slices.SortFunc(out.Series, func(a, b reportPointJSON) int { return cmp.Compare(a.Period, b.Period) })
	return out, "", nil
}

// period is the range the report covers: period words, explicit dates as count_records takes them,
// or nil for the whole record.
func (c readCall) period(words, fromRaw, toRaw string) (*reportPeriodJSON, string) {
	if words != "" {
		p, ok := domain.ResolvePeriod(words, c.now())
		if !ok {
			return nil, invalidPeriod
		}
		return &reportPeriodJSON{Label: p.Label, From: p.From, To: p.To}, ""
	}
	if fromRaw == "" && toRaw == "" {
		return nil, ""
	}
	from, okFrom := ontology.DayBound(fromRaw, false)
	to, okTo := ontology.DayBound(toRaw, true)
	if !okFrom || !okTo {
		return nil, invalidDates
	}
	label := fromRaw + " a " + toRaw
	switch {
	case toRaw == "":
		label = "desde " + fromRaw
	case fromRaw == "":
		label = "hasta " + toRaw
	}
	return &reportPeriodJSON{Label: label, From: from, To: to}, ""
}

func (c readCall) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

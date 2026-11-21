package application

import (
	"cmp"
	"context"
	"encoding/csv"
	"slices"
	"strconv"
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
	if format == "" {
		format = "json" // blank, as every blank argument, is the default
	}
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
	if format == "csv" {
		text := reportCSV(out)
		out.CSV = &text
	}
	return out, "", nil
}

// csvBOM and CRLF make a spreadsheet open the text as UTF-8, as the web's own exports do.
const csvBOM = "\uFEFF"

// noValue names the group of records without the field, as a person reads the sheet.
const noValue = "(sin valor)"

// asCSVText keeps text a spreadsheet would run as a formula as text (OWASP CSV injection): a
// leading =, +, -, @, tab or carriage return, even after spaces, gets an apostrophe in front.
func asCSVText(text string) string {
	if text != "" && strings.ContainsRune("\t\r", rune(text[0])) {
		return "'" + text
	}
	if rest := strings.TrimLeft(text, " "); rest != "" && strings.ContainsRune("=+-@", rune(rest[0])) {
		return "'" + text
	}
	return text
}

// reportCSV is the report as CSV: the groups or the series with a header, then the total. Built
// from values the guard's session already sanitised; the release scrubs it again with the rest.
func reportCSV(r reportJSON) string {
	var b strings.Builder
	b.WriteString(csvBOM)
	w := csv.NewWriter(&b)
	w.UseCRLF = true
	switch {
	case r.GroupBy != nil:
		_ = w.Write([]string{*r.GroupBy, "cantidad"})
		for _, g := range r.Groups {
			value := noValue
			switch {
			case g.Value != nil && g.Value.IsNumber:
				value = groupKey{isNumber: true, number: g.Value.Number}.asText()
			case g.Value != nil:
				value = asCSVText(g.Value.Text)
			}
			_ = w.Write([]string{value, strconv.Itoa(g.Count)})
		}
		_ = w.Write([]string{"Total", strconv.Itoa(r.Total)})
	case r.By != nil:
		_ = w.Write([]string{*r.By, "cantidad"})
		for _, p := range r.Series {
			_ = w.Write([]string{p.Period, strconv.Itoa(p.Count)})
		}
		_ = w.Write([]string{"Total", strconv.Itoa(r.Total)})
	default:
		_ = w.Write([]string{"Total"})
		_ = w.Write([]string{strconv.Itoa(r.Total)})
	}
	if r.Truncated {
		_ = w.Write([]string{"Aviso", "conteo parcial: se leyó el máximo de registros"})
	}
	w.Flush()
	return b.String()
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

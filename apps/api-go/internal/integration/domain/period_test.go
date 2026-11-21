package domain_test

import (
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
)

// odd/tasks/reporting-mcp.md S7: period words resolve to a day range in Lima time (UTC-5), in code.
// 03:00 UTC on 2026-11-20 is 22:00 on Thursday 2026-11-19 in Lima: «hoy» is the 19th.
var thursdayNight = time.Date(2026, 11, 20, 3, 0, 0, 0, time.UTC)

func TestPeriodWordsResolveToLimaDayRanges(t *testing.T) {
	t.Parallel()
	cases := []struct{ words, from, to, label string }{
		{"hoy", "2026-11-19", "2026-11-19", "hoy"},
		{"ayer", "2026-11-18", "2026-11-18", "ayer"},
		{"esta semana", "2026-11-16", "2026-11-22", "esta semana"},
		{"semana pasada", "2026-11-09", "2026-11-15", "semana pasada"},
		{"este mes", "2026-11-01", "2026-11-30", "este mes"},
		{"mes pasado", "2026-10-01", "2026-10-31", "mes pasado"},
		{"este año", "2026-01-01", "2026-12-31", "este año"},
		{"año pasado", "2025-01-01", "2025-12-31", "año pasado"},
		{"últimos 7 días", "2026-11-13", "2026-11-19", "últimos 7 días"},
		{"ultimos 30 dias", "2026-10-21", "2026-11-19", "últimos 30 días"},
		{"  Este   AÑO ", "2026-01-01", "2026-12-31", "este año"},
		{"ESTE MES", "2026-11-01", "2026-11-30", "este mes"},
		{"últimos 007 días", "2026-11-13", "2026-11-19", "últimos 7 días"},
	}
	for _, c := range cases {
		got, ok := domain.ResolvePeriod(c.words, thursdayNight)
		if !ok {
			t.Errorf("%q: refused", c.words)
			continue
		}
		if got.From != c.from || got.To != c.to || got.Label != c.label {
			t.Errorf("%q = %+v, want %s..%s labelled %q", c.words, got, c.from, c.to, c.label)
		}
	}
}

func TestPeriodsCrossMonthAndYearEdges(t *testing.T) {
	t.Parallel()
	january := time.Date(2026, 1, 10, 15, 0, 0, 0, time.UTC)
	if got, _ := domain.ResolvePeriod("mes pasado", january); got.From != "2025-12-01" || got.To != "2025-12-31" {
		t.Errorf("mes pasado in January = %+v", got)
	}
	leapMarch := time.Date(2028, 3, 5, 15, 0, 0, 0, time.UTC)
	if got, _ := domain.ResolvePeriod("mes pasado", leapMarch); got.From != "2028-02-01" || got.To != "2028-02-29" {
		t.Errorf("mes pasado in a leap March = %+v", got)
	}
	// Sunday in Lima belongs to the week that began the Monday before.
	sunday := time.Date(2026, 11, 23, 4, 0, 0, 0, time.UTC) // 23:00 Sunday 22nd in Lima
	if got, _ := domain.ResolvePeriod("esta semana", sunday); got.From != "2026-11-16" || got.To != "2026-11-22" {
		t.Errorf("esta semana on Sunday night = %+v", got)
	}
	newYear := time.Date(2027, 1, 1, 6, 0, 0, 0, time.UTC) // 01:00 on 1 January in Lima
	if got, _ := domain.ResolvePeriod("ayer", newYear); got.From != "2026-12-31" || got.To != "2026-12-31" {
		t.Errorf("ayer on 1 January = %+v", got)
	}
}

func TestUnknownPeriodWordsAreRefused(t *testing.T) {
	t.Parallel()
	for _, words := range []string{"", "mañana", "la semana que viene", "últimos 0 días", "últimos 367 días", "últimos x días", "últimos 7"} {
		if got, ok := domain.ResolvePeriod(words, thursdayNight); ok {
			t.Errorf("%q resolved to %+v, want a refusal", words, got)
		}
	}
	if got, ok := domain.ResolvePeriod("últimos 366 días", thursdayNight); !ok || got.From != "2025-11-19" {
		t.Errorf("últimos 366 días = %+v, %v", got, ok)
	}
}

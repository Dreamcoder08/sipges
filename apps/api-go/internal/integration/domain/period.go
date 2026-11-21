package domain

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Period words for reports (odd/tasks/reporting-mcp.md S7): a person says «este mes», the code turns
// it into days, so no model has to work out a calendar. Days are Lima's (UTC-5 all year); weeks run
// Monday to Sunday, as in Peru.

// PeriodWords lists the accepted words, as a refusal names them.
const PeriodWords = "hoy, ayer, esta semana, semana pasada, este mes, mes pasado, este año, año pasado, últimos N días (1 a 366)"

// MaxLastDays bounds «últimos N días».
const MaxLastDays = 366

var limaZone = time.FixedZone("America/Lima", -5*60*60)

// Period is a resolved range of whole days, YYYY-MM-DD, both included, and the words it came from.
type Period struct {
	Label string
	From  string
	To    string
}

var lastDays = regexp.MustCompile(`^ultimos ([0-9]{1,3}) dias$`)

// ResolvePeriod turns period words into Lima days around now; false for words it does not know.
func ResolvePeriod(words string, now time.Time) (Period, bool) {
	key := strings.Join(strings.Fields(Fold(words)), " ")
	today := now.In(limaZone)
	day := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, limaZone)
	span := func(label string, from, to time.Time) (Period, bool) {
		return Period{Label: label, From: from.Format(time.DateOnly), To: to.Format(time.DateOnly)}, true
	}
	// Monday of this week: Go counts Sunday as 0.
	monday := day.AddDate(0, 0, -((int(day.Weekday()) + 6) % 7))
	month := time.Date(day.Year(), day.Month(), 1, 0, 0, 0, 0, limaZone)
	year := time.Date(day.Year(), 1, 1, 0, 0, 0, 0, limaZone)
	switch key {
	case "hoy":
		return span("hoy", day, day)
	case "ayer":
		return span("ayer", day.AddDate(0, 0, -1), day.AddDate(0, 0, -1))
	case "esta semana":
		return span("esta semana", monday, monday.AddDate(0, 0, 6))
	case "semana pasada":
		return span("semana pasada", monday.AddDate(0, 0, -7), monday.AddDate(0, 0, -1))
	case "este mes":
		return span("este mes", month, month.AddDate(0, 1, -1))
	case "mes pasado":
		return span("mes pasado", month.AddDate(0, -1, 0), month.AddDate(0, 0, -1))
	case "este ano":
		return span("este año", year, year.AddDate(1, 0, -1))
	case "ano pasado":
		return span("año pasado", year.AddDate(-1, 0, 0), year.AddDate(0, 0, -1))
	}
	if m := lastDays.FindStringSubmatch(key); m != nil {
		n, _ := strconv.Atoi(m[1])
		if n >= 1 && n <= MaxLastDays {
			return span("últimos "+strconv.Itoa(n)+" días", day.AddDate(0, 0, 1-n), day)
		}
	}
	return Period{}, false
}

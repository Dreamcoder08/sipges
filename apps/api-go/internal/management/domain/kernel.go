package domain

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/text/unicode/norm"
)

// The helpers of packages/kernel/src/calendar.ts and numbers.ts that overview.ts uses, with
// JavaScript's string semantics.

var calendarDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// IsValidCalendarDate is isValidCalendarDate: a real proleptic Gregorian YYYY-MM-DD date.
func IsValidCalendarDate(value string) bool {
	if !calendarDate.MatchString(value) {
		return false
	}
	year, _ := strconv.Atoi(value[0:4])
	month, _ := strconv.Atoi(value[5:7])
	day, _ := strconv.Atoi(value[8:10])
	if year < 1 || month < 1 || month > 12 || day < 1 {
		return false
	}
	leap := year%4 == 0 && (year%100 != 0 || year%400 == 0)
	days := [12]int{31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}
	if leap {
		days[1] = 29
	}
	return day <= days[month-1]
}

// jsSpace is JavaScript's WhiteSpace and LineTerminator set, which String.prototype.trim and
// the regular expression \s use (Go's unicode.IsSpace adds U+0085 and lacks U+FEFF).
func jsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// normalizeSpanishStatus is normalizeSpanishStatus: NFD, combining marks U+0300–U+036F
// removed, trimmed, lower-cased, inner whitespace runs collapsed to one space.
func normalizeSpanishStatus(value string) string {
	var b strings.Builder
	for _, r := range norm.NFD.String(value) {
		if r < 0x300 || r > 0x36f {
			b.WriteRune(r)
		}
	}
	fields := strings.FieldsFunc(strings.ToLower(strings.TrimFunc(b.String(), jsSpace)), jsSpace)
	return strings.Join(fields, " ")
}

var completedStatuses = map[string]bool{
	"cumplido": true, "cumplida": true, "completado": true, "completada": true,
	"cerrado": true, "cerrada": true, "atendido": true, "atendida": true,
	"resuelto": true, "resuelta": true, "finalizado": true, "finalizada": true,
}

// IsCompletedStatus is isCompletedStatus.
func IsCompletedStatus(value string) bool { return completedStatuses[normalizeSpanishStatus(value)] }

// IsTerminalStatus is isTerminalStatus: completed or cancelled.
func IsTerminalStatus(value string) bool {
	s := normalizeSpanishStatus(value)
	return completedStatuses[s] || s == "cancelado" || s == "cancelada"
}

// lima is America/Lima, which has kept UTC-5 without daylight saving since 1994; a fixed zone
// gives the same day as Intl for any current clock without depending on the host's tzdata.
var lima = time.FixedZone("America/Lima", -5*60*60)

// LimaToday is limaToday: the calendar day in Peru, YYYY-MM-DD.
func LimaToday(now time.Time) string { return now.In(lima).Format(time.DateOnly) }

// RecordDueDate is recordDueDate: the first of Fecha_Vencimiento, Fecha_Limite and Plazo that
// is present decides; a cleared or malformed value gives "" (null) without falling back.
func RecordDueDate(payload Payload) string {
	for _, key := range []string{"Fecha_Vencimiento", "Fecha_Limite", "Plazo"} {
		value, ok := payload.Get(key)
		if !ok {
			continue
		}
		if s, isString := value.(string); isString && IsValidCalendarDate(s) {
			return s
		}
		return ""
	}
	return ""
}

// RoundHalfEven is roundHalfEven of numbers.ts, operation for operation, so it rounds the same
// float64 values the same way (Python's round on the sums it is used for).
func RoundHalfEven(value float64, digits int) float64 {
	factor := math.Pow(10, float64(digits))
	scaled := value * factor
	floor := math.Floor(scaled)
	diff := scaled - floor
	var rounded float64
	switch {
	case diff > 0.5:
		rounded = floor + 1
	case diff < 0.5:
		rounded = floor
	case math.Mod(floor, 2) == 0:
		rounded = floor
	default:
		rounded = floor + 1
	}
	return rounded / factor
}

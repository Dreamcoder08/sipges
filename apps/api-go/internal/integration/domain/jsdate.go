package domain

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ParseDateJS is Date.parse as Node (V8) reads the dates feeds carry, with the process in UTC
// (as the TypeScript API runs): the ECMAScript date-time format, and the RFC 822/1123 forms of
// RSS (`Mon, 02 Jan 2006 15:04:05 GMT`, numeric or North American zones, two-digit years, a
// trailing comment), `Jan 2 2006 15:04:05 GMT+0200` and `2006-01-02 15:04:05`. Out-of-range days
// roll over as in JavaScript (31 Feb is 3 Mar). V8's legacy parser accepts more shapes; any other
// one reads as no date here (the item keeps no published_at), which only loses the date.
func ParseDateJS(value string) (time.Time, bool) {
	s := TrimJS(value)
	if m := isoDateTime.FindStringSubmatch(s); m != nil {
		return isoParts(m)
	}
	s = strings.TrimSpace(comment.ReplaceAllString(s, " "))
	if m := rfcDate.FindStringSubmatch(s); m != nil {
		return legacy(m[1], m[2], m[3], m[4], m[5], m[6], m[7]+m[8])
	}
	if m := monthFirst.FindStringSubmatch(s); m != nil {
		return legacy(m[2], m[1], m[3], m[4], m[5], m[6], m[7]+m[8])
	}
	if m := spacedISO.FindStringSubmatch(s); m != nil {
		return legacyNumeric(m)
	}
	return time.Time{}, false
}

const zone = `(Z|UTC?|GMT|[ECMP][SD]T)?\s*([+-]\d{2}:?\d{2})?`

var (
	isoDateTime = regexp.MustCompile(`^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?([Zz]|[+-]\d{2}:\d{2})?)?$`)
	comment     = regexp.MustCompile(`\([^()]*\)`)
	rfcDate     = regexp.MustCompile(`^(?i)(?:[a-z]+,?\s+)?(\d{1,2})[\s-]+([a-z]{3,})[\s-]+(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*` + zone + `$`)
	monthFirst  = regexp.MustCompile(`^(?i)(?:[a-z]+,?\s+)?([a-z]{3,})\s+(\d{1,2}),?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*` + zone + `$`)
	spacedISO   = regexp.MustCompile(`^(?i)(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*` + zone + `$`)
	months      = map[string]time.Month{"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
	zoneHours   = map[string]int{"": 0, "z": 0, "ut": 0, "utc": 0, "gmt": 0, "est": -5, "edt": -4, "cst": -6, "cdt": -5, "mst": -7, "mdt": -6, "pst": -8, "pdt": -7}
)

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

func isoParts(m []string) (time.Time, bool) {
	if m[1] == "-000000" {
		return time.Time{}, false
	}
	year, month, day := atoi(strings.TrimPrefix(m[1], "+")), 1, 1
	if m[2] != "" {
		month = atoi(m[2])
	}
	if m[3] != "" {
		day = atoi(m[3])
	}
	hour, minute, second, ms := atoi(m[4]), atoi(m[5]), atoi(m[6]), 0
	if m[7] != "" {
		ms = atoi((m[7] + "00")[:3])
	}
	if month < 1 || month > 12 || day < 1 || day > 31 || minute > 59 || second > 59 ||
		hour > 24 || hour == 24 && (minute > 0 || second > 0 || ms > 0) {
		return time.Time{}, false
	}
	offset := 0
	if z := m[8]; len(z) == 6 {
		h, mm := atoi(z[1:3]), atoi(z[4:6])
		if h > 23 || mm > 59 {
			return time.Time{}, false
		}
		offset = (h*60 + mm) * 60
		if z[0] == '-' {
			offset = -offset
		}
	}
	t := time.Date(year, time.Month(month), day, hour, minute, second, ms*int(time.Millisecond), time.UTC)
	return t.Add(-time.Duration(offset) * time.Second), true
}

func legacy(day, monthName, year, hour, minute, second, zoneName string) (time.Time, bool) {
	month, ok := months[strings.ToLower(monthName[:3])]
	if !ok {
		return time.Time{}, false
	}
	y := atoi(year)
	if len(year) == 2 {
		if y < 50 {
			y += 2000
		} else {
			y += 1900
		}
	}
	return compose(y, int(month), atoi(day), hour, minute, second, zoneName)
}

func legacyNumeric(m []string) (time.Time, bool) {
	return compose(atoi(m[1]), atoi(m[2]), atoi(m[3]), m[4], m[5], m[6], m[7]+m[8])
}

func compose(year, month, day int, hour, minute, second, zoneSpec string) (time.Time, bool) {
	h, mi, se := atoi(hour), atoi(minute), atoi(second)
	if month < 1 || month > 12 || day < 1 || day > 31 || h > 24 || mi > 59 || se > 59 ||
		h == 24 && (mi > 0 || se > 0) {
		return time.Time{}, false
	}
	offset, ok := zoneOffset(zoneSpec)
	if !ok {
		return time.Time{}, false
	}
	t := time.Date(year, time.Month(month), day, h, mi, se, 0, time.UTC)
	return t.Add(-time.Duration(offset) * time.Second), true
}

// zoneOffset reads a zone name, a numeric offset (±hhmm or ±hh:mm) or both (GMT+0200).
func zoneOffset(spec string) (int, bool) {
	name := strings.ToLower(strings.TrimRight(spec, "+-0123456789:"))
	base, ok := zoneHours[strings.TrimSpace(name)]
	if !ok {
		return 0, false
	}
	numeric := strings.TrimSpace(spec[len(strings.TrimRight(spec, "+-0123456789:")):])
	if numeric == "" {
		return base * 3600, true
	}
	digits := strings.ReplaceAll(numeric[1:], ":", "")
	h, m := atoi(digits[:2]), atoi(digits[2:])
	if h > 23 || m > 59 {
		return 0, false
	}
	offset := (h*60 + m) * 60
	if numeric[0] == '-' {
		offset = -offset
	}
	return offset, true
}

// ISOString is Date.prototype.toISOString (milliseconds, UTC; six-digit signed years outside
// 0000–9999).
func ISOString(t time.Time) string {
	t = t.UTC()
	rest := t.Format("-01-02T15:04:05.000Z")
	switch y := t.Year(); {
	case y >= 0 && y <= 9999:
		return fmt.Sprintf("%04d", y) + rest
	case y < 0:
		return fmt.Sprintf("-%06d", -y) + rest
	default:
		return fmt.Sprintf("+%06d", y) + rest
	}
}

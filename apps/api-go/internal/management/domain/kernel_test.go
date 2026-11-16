package domain

import (
	"testing"
	"time"
)

// Ported from packages/kernel/src/calendar.test.ts and the roundHalfEven contract of numbers.ts.

func TestIsValidCalendarDate(t *testing.T) {
	for value, want := range map[string]bool{
		"2024-02-29": true, "2023-02-29": false, "2026-02-30": false, "2026-12-31": true,
		"0000-01-01": false, "2026-13-01": false, "2026-00-10": false, "2026-1-01": false,
		"": false, "2026-10-15T00:00:00Z": false, "1900-02-29": false, "2000-02-29": true,
	} {
		if got := IsValidCalendarDate(value); got != want {
			t.Errorf("IsValidCalendarDate(%q) = %v, want %v", value, got, want)
		}
	}
}

func TestStatusesNormalizeAccentsCaseAndSpaces(t *testing.T) {
	for _, value := range []string{"Cumplido", " CUMPLIDA ", "Completada", "Cerrádo", "finalizada", "Cancelado", "Cancelada"} {
		if !IsTerminalStatus(value) {
			t.Errorf("IsTerminalStatus(%q) = false", value)
		}
	}
	if IsTerminalStatus("Incumplido") || IsTerminalStatus("Pendiente") || IsTerminalStatus("En ejecución") {
		t.Error("ongoing statuses read as terminal")
	}
	if !IsCompletedStatus("Cumplido") || IsCompletedStatus("Cancelada") {
		t.Error("completed set differs from the kernel's")
	}
	if !IsCompletedStatus("resuelto ") || !IsCompletedStatus("RESUELTA") {
		t.Error("trim or case differs from JavaScript")
	}
}

func TestLimaTodayUsesThePeruvianCalendarDay(t *testing.T) {
	if got := LimaToday(time.Date(2026, 10, 15, 3, 0, 0, 0, time.UTC)); got != "2026-10-14" {
		t.Errorf("03:00Z = %s", got)
	}
	if got := LimaToday(time.Date(2026, 10, 15, 5, 0, 0, 0, time.UTC)); got != "2026-10-15" {
		t.Errorf("05:00Z = %s", got)
	}
	if got := LimaToday(time.Date(2026, 10, 15, 4, 59, 59, 999e6, time.UTC)); got != "2026-10-14" {
		t.Errorf("04:59:59.999Z = %s", got)
	}
}

func TestLimaTodayAcrossDayMonthAndYearBoundaries(t *testing.T) {
	minus5 := time.FixedZone("UTC-5", -5*60*60)
	for _, c := range []struct {
		at   time.Time
		want string
	}{
		{time.Date(2026, 11, 13, 23, 30, 0, 0, minus5), "2026-11-13"},
		{time.Date(2026, 11, 14, 0, 0, 0, 0, minus5), "2026-11-14"},
		{time.Date(2026, 11, 30, 23, 30, 0, 0, minus5), "2026-11-30"},
		{time.Date(2026, 12, 1, 0, 0, 0, 0, minus5), "2026-12-01"},
		{time.Date(2026, 12, 31, 23, 30, 0, 0, minus5), "2026-12-31"},
		{time.Date(2027, 1, 1, 0, 0, 0, 0, minus5), "2027-01-01"},
		{time.Date(2027, 1, 1, 4, 59, 59, 0, time.UTC), "2026-12-31"},
	} {
		if got := LimaToday(c.at); got != c.want {
			t.Errorf("LimaToday(%s) = %s, want %s", c.at.UTC().Format(time.RFC3339), got, c.want)
		}
	}
}

func TestRecordDueDateStopsAtTheFirstPresentKey(t *testing.T) {
	for raw, want := range map[string]string{
		`{"Fecha_Vencimiento":"2026-10-15","Fecha_Limite":"2026-10-16","Plazo":"2026-10-17"}`: "2026-10-15",
		`{"Fecha_Vencimiento":"2026-02-30","Plazo":"2026-10-17"}`:                             "",
		`{"Fecha_Limite":"2026-10-16"}`:                                                       "2026-10-16",
		`{"Plazo":"2026-10-17"}`:                                                              "2026-10-17",
		`{"Plazo":"30 días después de la reunión"}`:                                           "",
		`{"Fecha_Limite":null,"Plazo":"2020-01-03"}`:                                          "",
		`{"Fecha_Limite":"","Plazo":"2020-01-03"}`:                                            "",
		`{"Fecha_Limite":20201003,"Plazo":"2020-01-03"}`:                                      "",
		`{}`: "",
	} {
		payload, err := ParsePayload([]byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		if got := RecordDueDate(payload); got != want {
			t.Errorf("RecordDueDate(%s) = %q, want %q", raw, got, want)
		}
	}
}

func TestRoundHalfEvenMatchesTheKernel(t *testing.T) {
	for _, c := range []struct {
		value  float64
		digits int
		want   float64
	}{
		{2.5, 0, 2}, {3.5, 0, 4}, {0.25, 1, 0.2}, {0.35, 1, 0.4}, {100.0 / 3, 1, 33.3},
		{200.0 / 3, 1, 66.7}, {50, 1, 50}, {12.45, 1, 12.4}, {0, 1, 0}, {87.5, 0, 88},
	} {
		if got := RoundHalfEven(c.value, c.digits); got != c.want {
			t.Errorf("RoundHalfEven(%v, %d) = %v, want %v", c.value, c.digits, got, c.want)
		}
	}
}

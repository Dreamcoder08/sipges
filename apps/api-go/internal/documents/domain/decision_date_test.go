//nolint:misspell // Spanish themes and fields, verbatim from the TypeScript API.
package domain

import (
	"testing"
	"time"
)

// The record an approved finding creates is dated with the decision's calendar day in Peru
// (UTC−5), not the UTC date, as review-records.ts.
func TestReviewRecordDateIsTheLimaDayOfTheDecision(t *testing.T) {
	minus5 := time.FixedZone("UTC-5", -5*60*60)
	valueOf := func(fields []Field, name string) string {
		for _, field := range fields {
			if field.Key == name {
				return field.Value
			}
		}
		return "<missing>"
	}
	for _, c := range []struct {
		at   time.Time
		want string
	}{
		{time.Date(2026, 11, 13, 23, 30, 0, 0, minus5), "2026-11-13"},
		{time.Date(2026, 11, 30, 23, 30, 0, 0, minus5), "2026-11-30"},
		{time.Date(2026, 12, 31, 23, 30, 0, 0, minus5), "2026-12-31"},
	} {
		for theme, name := range map[string]string{
			"Demandas e intereses":       "Fecha_Registro",
			"Compromisos y trazabilidad": "Fecha",
			"Territorio y ambiente":      "Fecha_Observacion",
		} {
			item := ReviewItem{
				ID: "itemsintetico", ProjectID: "PRJ-SINTETICO", SourceFile: "acta-sintetica.txt",
				SourceSHA256: "aaaa", Location: "Línea 1", Theme: theme, Excerpt: "Fragmento sintético",
				Status: StatusAccepted, Reviewer: "revisora", UpdatedAt: c.at,
			}
			if got := valueOf(ReviewRecordFields(item, "PRJ-SINTETICO"), name); got != c.want {
				t.Errorf("%s decided at %s: %s = %s, want %s", theme, c.at.UTC().Format(time.RFC3339), name, got, c.want)
			}
		}
	}
}

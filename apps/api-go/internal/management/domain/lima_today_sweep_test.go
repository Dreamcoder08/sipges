package domain

import (
	"testing"
	"time"
)

// LimaToday is UTC−5 for every half hour of 2026 and 2027, whatever zone the instant carries:
// Peru has no daylight saving, so no instant may fall on another day.
func TestLimaTodaySweepsTwoYearsAsUTCMinusFive(t *testing.T) {
	zones := []*time.Location{
		time.UTC,
		time.FixedZone("UTC+14", 14*60*60),
		time.FixedZone("UTC-12", -12*60*60),
		time.FixedZone("UTC+5:30", 5*60*60+30*60),
	}
	end := time.Date(2028, 1, 1, 0, 0, 0, 0, time.UTC)
	for at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC); at.Before(end); at = at.Add(30 * time.Minute) {
		// Independent of zone conversion: the UTC date of the instant five hours earlier.
		want := at.UTC().Add(-5 * time.Hour).Format(time.DateOnly)
		for _, zone := range zones {
			if got := LimaToday(at.In(zone)); got != want {
				t.Fatalf("LimaToday(%s) = %s, want %s", at.In(zone).Format(time.RFC3339), got, want)
			}
		}
	}
}

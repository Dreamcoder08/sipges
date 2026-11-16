package application_test

import (
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/application"
)

// "Today" for the overdue rule is the calendar day in Peru (UTC−5), not the UTC date, as
// limaToday of @sipges/kernel.
func TestTodayIsTheLimaCalendarDay(t *testing.T) {
	minus5 := time.FixedZone("UTC-5", -5*60*60)
	for _, c := range []struct {
		at   time.Time
		want string
	}{
		{time.Date(2026, 11, 13, 23, 30, 0, 0, minus5), "2026-11-13"},
		{time.Date(2026, 11, 30, 23, 30, 0, 0, minus5), "2026-11-30"},
		{time.Date(2026, 12, 31, 23, 30, 0, 0, minus5), "2026-12-31"},
	} {
		s := application.Service{Now: func() time.Time { return c.at }}
		if got := s.Today(); got != c.want {
			t.Errorf("Today() at %s = %s, want %s", c.at.UTC().Format(time.RFC3339), got, c.want)
		}
	}
}

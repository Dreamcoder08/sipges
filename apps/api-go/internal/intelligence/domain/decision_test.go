package domain_test

import (
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/domain"
)

func TestFourEyesFollowsTheTypeScriptRule(t *testing.T) {
	const (
		pending  = "Pendiente de verificación"
		verified = "Corroborado"
		followed = "En seguimiento"
		dropped  = "Descartado"
	)
	for _, c := range []struct {
		level, current, next, first, actor string
		want                               domain.FourEyesOutcome
	}{
		{"Media", pending, verified, "", "ana", domain.Apply},
		{"Baja", pending, followed, "", "ana", domain.Apply},
		{"Alta", pending, dropped, "", "ana", domain.Apply},
		{"Alta", verified, followed, "", "ana", domain.Apply},
		{"Alta", followed, pending, "", "ana", domain.Apply},
		{"Alta", pending, verified, "", "ana", domain.First},
		{"Alta", dropped, followed, "", "ana", domain.First},
		{"Alta", pending, verified, "ana", "ana", domain.SamePerson},
		{"Alta", pending, followed, "ana", "beto", domain.Apply},
		// level is compared exactly, as the TypeScript does.
		{"alta", pending, verified, "", "ana", domain.Apply},
	} {
		got := domain.FourEyes(c.level, c.current, c.next, c.first, c.actor)
		if got != c.want {
			t.Errorf("%+v: got %v, want %v", c, got, c.want)
		}
	}
}

func TestCheckDecisionValidatesInTheTypeScriptOrder(t *testing.T) {
	long := strings.Repeat("ñ", domain.MaxNoteLength)
	for _, c := range []struct {
		id, status, note string
		want             domain.DecisionError
	}{
		{"DIG-1", "Corroborado", "", ""},
		{"DIG-1", "corroborado", "", domain.ErrStatus},
		{"DIG-1", "", strings.Repeat("x", 3000), domain.ErrStatus},
		// 2000 code points pass even when they take more UTF-16 units or bytes.
		{"DIG-1", "Descartado", long, ""},
		{"DIG-1", "Descartado", strings.Repeat("😀", domain.MaxNoteLength), ""},
		{"DIG-1", "Descartado", long + "x", domain.ErrNoteTooLong},
		{strings.Repeat("A", 65), "Descartado", long + "x", domain.ErrNoteTooLong},
		{strings.Repeat("A", 64), "Descartado", "", ""},
		{strings.Repeat("A", 65), "Descartado", "", domain.ErrMissing},
		// The id limit counts UTF-16 units: 33 astral characters are 66 units.
		{strings.Repeat("😀", 32), "Descartado", "", ""},
		{strings.Repeat("😀", 33), "Descartado", "", domain.ErrMissing},
	} {
		if got := domain.CheckDecision(c.id, c.status, c.note); got != c.want {
			t.Errorf("CheckDecision(%.10q, %q, %d runes) = %q, want %q", c.id, c.status, len([]rune(c.note)), got, c.want)
		}
	}
}

func TestDecisionAuditDetail(t *testing.T) {
	if got := domain.DecisionDetail("Corroborado", nil); got != "Corroborado" {
		t.Fatal(got)
	}
	first := "ana"
	if got := domain.DecisionDetail("Corroborado", &first); got != "Corroborado (primera validación: ana)" {
		t.Fatal(got)
	}
	if got := domain.FirstValidationDetail("ana"); got != "Primera validación: ana" {
		t.Fatal(got)
	}
}

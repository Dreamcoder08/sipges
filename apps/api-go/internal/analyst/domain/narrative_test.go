package domain_test

import (
	"slices"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
)

func TestBriefingTextIsWhatTheNarratorReads(t *testing.T) {
	t.Parallel()
	got := domain.BriefingText(domain.Briefing{
		Sources: []domain.Source{{Ref: 1, TypeLabel: "Actor", ID: "A-1", Title: "  Comunidad   sintética "}},
		Sections: []domain.Section{{Title: "Resumen", Sentences: []domain.Sentence{
			{Text: "Con dos fuentes.", Refs: []int{1, 2}}, {Text: "Sin fuentes."},
		}}},
	})
	want := "## Resumen\n- Con dos fuentes. [1][2]\n- Sin fuentes.\n## Fuentes\n[1] Actor A-1: Comunidad sintética"
	if got != want {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
}

func TestCitedRefsAreUniqueAndSorted(t *testing.T) {
	t.Parallel()
	briefing := domain.Briefing{Sources: []domain.Source{{Ref: 1}, {Ref: 2}, {Ref: 12}}}
	cases := []struct {
		text string
		want []int
		ok   bool
	}{
		{"a [12] b [1] c [1] d [01]", []int{1, 12}, true},
		{"sin citas", nil, true},
		{"a [1] b [3]", nil, false},
		{"[12345] no es una marca", nil, true},
	}
	for _, c := range cases {
		got, ok := domain.CitedRefs(c.text, briefing)
		if ok != c.ok || !slices.Equal(got, c.want) {
			t.Errorf("%q: %v %v", c.text, got, ok)
		}
	}
}

func TestRenumberMovesCitationsRecordByRecord(t *testing.T) {
	t.Parallel()
	shared := domain.Briefing{Sources: []domain.Source{{Ref: 1, Slug: "actores", ID: "A"}, {Ref: 2, Slug: "eventos", ID: "E"}}}
	full := domain.Briefing{Sources: []domain.Source{
		{Ref: 1, Slug: "actores", ID: "A"}, {Ref: 2, Slug: "eventos", ID: "R"}, {Ref: 3, Slug: "eventos", ID: "E"},
	}}
	text, refs := domain.RenumberCitations("uno [1], dos [2], otro [9]", []int{1, 2}, shared, full)
	if text != "uno [1], dos [3], otro [0]" || !slices.Equal(refs, []int{1, 3}) {
		t.Fatalf("%q %v", text, refs)
	}
}

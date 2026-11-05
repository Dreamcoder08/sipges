package domain_test

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/domain"
)

func TestCosine(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		a, b []float64
		want float64
	}{
		{"same direction", []float64{1, 2}, []float64{2, 4}, 1},
		{"orthogonal", []float64{1, 0}, []float64{0, 1}, 0},
		{"opposite", []float64{1, 0}, []float64{-1, 0}, -1},
		{"different lengths are unrelated", []float64{1, 0}, []float64{1, 0, 0}, 0},
		{"a zero vector", []float64{0, 0}, []float64{1, 1}, 0},
		{"empty", nil, nil, 0},
	}
	for _, c := range cases {
		if got := domain.Cosine(c.a, c.b); math.Abs(got-c.want) > 1e-12 {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestIsPublicHTTPURL(t *testing.T) {
	t.Parallel()
	cases := map[string]bool{
		"https://example.org/a":  true,
		"http://example.org":     true,
		"HTTP://EXAMPLE.ORG":     true,
		"https://u:p@example.o":  true,
		"https://[::1]":          true,
		"https://a\nb":           true,
		"ftp://example.org":      false,
		"javascript://x":         false,
		"http://":                false,
		"http:///path":           false,
		"http://?q":              false,
		"http://#f":              false,
		"example.org":            false,
		"/relative":              false,
		"\thttps://example.org":  false,
		"1http://example.org":    false,
		"http+x://example.org":   false,
		"":                       false,
		"mailto:a@example.org":   false,
		"https:example.org/path": false,
	}
	for url, want := range cases {
		if got := domain.IsPublicHTTPURL(url); got != want {
			t.Errorf("%q: got %v, want %v", url, got, want)
		}
	}
}

func TestTrimJSRemovesWhatJavaScriptTrimRemoves(t *testing.T) {
	t.Parallel()
	in := "\ufeff\u00a0\u2003\u2028\u2029\t\n\v\f\r texto \u3000\u202f\u205f\u1680"
	if got := domain.TrimJS(in); got != "texto" {
		t.Fatalf("got %q", got)
	}
	if got := domain.TrimJS("\u200btexto\u0085"); got != "\u200btexto\u0085" {
		t.Fatalf("zero width space and NEL are not JavaScript whitespace: %q", got)
	}
}

func TestConceptsKeepTheirOrder(t *testing.T) {
	t.Parallel()
	if len(domain.SemanticConcepts) != 7 {
		t.Fatalf("%d concepts", len(domain.SemanticConcepts))
	}
	first, last := domain.SemanticConcepts[0], domain.SemanticConcepts[6]
	if first.Theme != "Ambiente y agua" || last.Theme != "Seguridad y emergencia" {
		t.Fatalf("%q, %q", first.Theme, last.Theme)
	}
}

func TestRankKeepsThoseAtTheThresholdBestFirstAndAtMostFive(t *testing.T) {
	t.Parallel()
	vectorAt := func(similarity float64) []float64 {
		return []float64{similarity, math.Sqrt(1 - similarity*similarity)}
	}
	matches := domain.Rank([]float64{1, 0}, [][]float64{
		vectorAt(0.379), vectorAt(0.38), vectorAt(0.9), vectorAt(0.9), vectorAt(0.5), vectorAt(0.6), vectorAt(0.7),
	})
	if len(matches) != 5 {
		t.Fatalf("matches = %+v", matches)
	}
	wantThemes := []string{
		domain.SemanticConcepts[2].Theme, domain.SemanticConcepts[3].Theme, domain.SemanticConcepts[6].Theme,
		domain.SemanticConcepts[5].Theme, domain.SemanticConcepts[4].Theme,
	}
	for i, want := range wantThemes {
		if matches[i].Theme != want {
			t.Errorf("match %d = %q, want %q", i, matches[i].Theme, want)
		}
	}
	if matches[0].Similarity != 0.9 || matches[0].Reference != domain.SemanticConcepts[2].Reference {
		t.Fatalf("first = %+v", matches[0])
	}
}

func TestRankRoundsToThreeDecimals(t *testing.T) {
	t.Parallel()
	matches := domain.Rank([]float64{1, 0}, [][]float64{{0.41234, math.Sqrt(1 - 0.41234*0.41234)}, {}, {}, {}, {}, {}, {}})
	if len(matches) != 1 || matches[0].Similarity != 0.412 {
		t.Fatalf("matches = %+v", matches)
	}
}

func TestRankOfNothingIsAnEmptyList(t *testing.T) {
	t.Parallel()
	matches := domain.Rank([]float64{1, 0}, make([][]float64, 7))
	body, err := json.Marshal(matches)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "[]" {
		t.Fatalf("%s", body)
	}
}

func TestOverlayReplacesInPlaceAndAppendsTheRest(t *testing.T) {
	t.Parallel()
	base := json.RawMessage(`{"version":"2.4","nested":{"b":1,"a":"<&>😀\u00e9"},"method":"reglas","n":1.50}`)
	got, err := domain.Overlay(base,
		domain.Field{Key: "version", Value: "2.5"},
		domain.Field{Key: "semantic", Value: map[string]bool{"active": false}},
		domain.Field{Key: "note", Value: "<sin escapar>"},
	)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"version":"2.5","nested":{"b":1,"a":"<&>😀\u00e9"},"method":"reglas","n":1.50,"semantic":{"active":false},"note":"<sin escapar>"}`
	if string(got) != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestOverlayRefusesWhatIsNotAnObject(t *testing.T) {
	t.Parallel()
	for _, base := range []string{`[]`, `"x"`, `{"a":1`, ``, `{"a":1} x`} {
		if got, err := domain.Overlay(json.RawMessage(base)); err == nil {
			t.Errorf("%q: got %s", base, got)
		}
	}
}

func TestOverlayLeavesLongStringsWhole(t *testing.T) {
	t.Parallel()
	text := strings.Repeat("é", 70_000)
	got, err := domain.Overlay(json.RawMessage(`{"a":"` + text + `"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), text) {
		t.Fatal("the value changed")
	}
}

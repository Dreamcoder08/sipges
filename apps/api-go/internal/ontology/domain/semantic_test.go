package domain_test

import (
	"encoding/json"
	"math"
	"slices"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
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
		{"different lengths", []float64{1, 0}, []float64{1, 0, 0}, 0},
		{"empty", nil, nil, 0},
		{"a zero vector", []float64{0, 0}, []float64{1, 1}, 0},
	}
	for _, c := range cases {
		if got := domain.Cosine(c.a, c.b); math.Abs(got-c.want) > 1e-12 {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestFuseRankings(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		lists [][]string
		limit int
		want  []string
	}{
		{"found by both ranks first", [][]string{{"a", "b", "c"}, {"c", "d"}}, 10, []string{"c", "a", "b", "d"}},
		{"ties keep the first list's order", [][]string{{"a", "b"}, {"c", "d"}}, 10, []string{"a", "c", "b", "d"}},
		{"a single list keeps its order", [][]string{{"b", "a"}, {}}, 10, []string{"b", "a"}},
		{"cut at the limit", [][]string{{"a", "b", "c"}}, 2, []string{"a", "b"}},
		{"nothing", [][]string{{}, {}}, 5, []string{}},
	}
	for _, c := range cases {
		if got := domain.FuseRankings(c.lists, c.limit); !slices.Equal(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func entries(t *testing.T, raw string) []domain.Entry {
	t.Helper()
	got, err := domain.OrderedEntries([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestOrderedEntriesFollowJavaScriptKeyOrder(t *testing.T) {
	t.Parallel()
	got := entries(t, `{"b":"1","a":2,"10":"x","2":"y","01":"z","4294967295":"w","4294967294":"v"}`)
	names := make([]string, len(got))
	for i, entry := range got {
		names[i] = entry.Name
	}
	want := []string{"2", "10", "4294967294", "b", "a", "01", "4294967295"}
	if !slices.Equal(names, want) {
		t.Fatalf("got %v, want %v", names, want)
	}
}

func TestOrderedEntriesKeepNumbersAndNestedValues(t *testing.T) {
	t.Parallel()
	got := entries(t, `{"n":1.50,"o":{"x":1},"l":[1],"t":true,"z":null}`)
	if got[0].Value != json.Number("1.50") {
		t.Fatalf("number = %#v", got[0].Value)
	}
	if len(got) != 5 || got[4].Value != nil {
		t.Fatalf("got %#v", got)
	}
}

func TestOrderedEntriesOfSomethingElseIsEmpty(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{`[]`, `"x"`, `1`, `null`} {
		if got := entries(t, raw); len(got) != 0 {
			t.Errorf("%s: %v", raw, got)
		}
	}
}

func TestEmbeddingTextKeepsStringsAndNumbers(t *testing.T) {
	t.Parallel()
	got := domain.EmbeddingText("Evento", "Título", entries(t,
		`{"Vacio":"  ","Texto":"  con espacios \n","Numero":1.50,"Cero":0,"Grande":1e21,"Si":true,"Nada":null,"Obj":{"a":"b"},"Lista":["c"]}`))
	want := "Evento: Título\nTexto: con espacios\nNumero: 1.5\nCero: 0\nGrande: 1e+21"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestEmbeddingTextCountsHalfAnEmojiAsOneCodePoint(t *testing.T) {
	t.Parallel()
	const half = "\xed\xa0\xbd" // a lone surrogate, kept as WTF-8
	const head = "T: t\nC: "
	got := domain.EmbeddingText("T", "t", []domain.Entry{{Name: "C", Value: strings.Repeat(half, 5000)}})
	want := head + strings.Repeat(half, 4000-len(head))
	if got != want {
		t.Fatalf("got %d bytes, want %d", len(got), len(want))
	}
}

func TestEmbeddingTextIsCutAtFourThousandCodePoints(t *testing.T) {
	t.Parallel()
	const head = "T: t\nC: "
	got := domain.EmbeddingText("T", "t", []domain.Entry{{Name: "C", Value: strings.Repeat("😀", 5000)}})
	want := head + strings.Repeat("😀", 4000-len(head))
	if got != want {
		t.Fatalf("got %d bytes", len(got))
	}
}

func TestVectorTextIsWhatJoinWrites(t *testing.T) {
	t.Parallel()
	got := domain.VectorText([]float64{1, 0.5, math.Copysign(0, -1), 1e21, 1.5e-7})
	if want := "{1,0.5,0,1e+21,1.5e-7}"; got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

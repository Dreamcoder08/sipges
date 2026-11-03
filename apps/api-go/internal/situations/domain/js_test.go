package domain

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

// fixture is the part of ../testdata/fixtures.json (written by generate.mjs from the TypeScript
// domain) that the helpers check against.
type fixture struct {
	Fold []struct {
		Input  string `json:"input"`
		Output string `json:"output"`
	} `json:"fold"`
	Pow []struct {
		HalfLife float64   `json:"half_life"`
		Values   []float64 `json:"values"`
	} `json:"pow"`
}

func readFixture(t *testing.T) fixture {
	t.Helper()
	raw, err := os.ReadFile("../testdata/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

// Node's pow is glibc's (within 0.52 ULP, not always correctly rounded); HalfPow rounds
// correctly, so a few grid values may differ, by one bit at most.
func TestHalfPowMatchesNodeOnTheScoreGrid(t *testing.T) {
	total, differ := 0, 0
	for _, row := range readFixture(t).Pow {
		for age, want := range row.Values {
			got := HalfPow(float64(age) / row.HalfLife)
			total++
			if got == want {
				continue
			}
			differ++
			if d := int64(math.Float64bits(got)) - int64(math.Float64bits(want)); d != 1 && d != -1 {
				t.Errorf("0.5 ** (%d / %v) = %v, Node %v", age, row.HalfLife, got, want)
			}
		}
	}
	if total == 0 || differ*1000 > total {
		t.Fatalf("%d of %d values differ from Node", differ, total)
	}
	t.Logf("%d of %d values differ from Node by one bit", differ, total)
}

func TestHalfPowSpecialValues(t *testing.T) {
	cases := map[float64]float64{
		0: 1, 1: 0.5, -10: 1024, 2: 0.25, 0.5: math.Sqrt(0.5), 1074: 5e-324, 1075.5: 0, 2000: 0,
		-1025: math.Inf(1), 1.5: 0.3535533905932738,
	}
	for in, want := range cases {
		if got := HalfPow(in); got != want {
			t.Errorf("HalfPow(%v) = %v, want %v", in, got, want)
		}
	}
	if got := HalfPow(math.NaN()); !math.IsNaN(got) {
		t.Errorf("HalfPow(NaN) = %v", got)
	}
}

func TestFoldMatchesTypeScript(t *testing.T) {
	for _, c := range readFixture(t).Fold {
		if got := Fold(c.Input); got != c.Output {
			t.Errorf("Fold(%q) = %q, want %q", c.Input, got, c.Output)
		}
	}
}

func TestJSNumberAndString(t *testing.T) {
	numbers := map[float64]string{
		1: "1", 1.5: "1.5", -0.25: "-0.25", 1e21: "1e+21", 1.5e-7: "1.5e-7", 1e-7: "1e-7",
		123456789012345680000: "123456789012345680000", math.Copysign(0, -1): "0", math.Inf(1): "Infinity",
	}
	for in, want := range numbers {
		if got := JSNumber(in); got != want {
			t.Errorf("JSNumber(%v) = %q, want %q", in, got, want)
		}
	}
	values := []struct {
		in   any
		want string
	}{
		{nil, ""},
		{true, "true"},
		{json.Number("1.0"), "1"},
		{json.Number("1e400"), "Infinity"},
		{[]any{json.Number("1"), nil, "a", []any{"b", "c"}}, "1,,a,b,c"},
		{map[string]any{"a": "b"}, "[object Object]"},
	}
	for _, c := range values {
		if got := JSString(c.in); got != c.want {
			t.Errorf("JSString(%#v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestReplaceAllJSExpandsDollarPatterns(t *testing.T) {
	got := ReplaceAllJS("Llamar a {a} y {a}.", "{a}", "X $& $$ $` $' $1 $")
	want := "Llamar a X {a} $ Llamar a   y {a}. $1 $ y X {a} $ Llamar a {a} y  . $1 $."
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestLess16OrdersByUTF16CodeUnits(t *testing.T) {
	if !Less16("\U0001F600", "！") { // surrogate 0xD83D < 0xFF01, while UTF-8 orders the other way
		t.Fatal("an astral character must sort before U+FF01")
	}
	if Less16("b", "a") || !Less16("a", "ab") || Less16("a", "a") {
		t.Fatal("ordinary comparisons broke")
	}
}

func TestRoundJS(t *testing.T) {
	for in, want := range map[float64]float64{0.5: 1, -0.5: -0, 1.5: 2, -1.5: -1, 0.49999999999999994: 0, 267.49999999999997: 267} {
		if got := RoundJS(in); got != want {
			t.Errorf("RoundJS(%v) = %v, want %v", in, got, want)
		}
	}
}

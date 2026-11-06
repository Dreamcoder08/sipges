package domain

import (
	"runtime"
	"strings"
	"testing"
)

func nestedArray(depth int, inner string) []any {
	list := []any{"", inner}
	for range depth {
		list = []any{"", list}
	}
	return list
}

// A read key can send a string field as an object whose `length` holds an array nested to the body
// parser's limit, so the text must cost the size of the array and never size × depth.
func TestArrayTextCostsTheSizeOfTheArrayNotItsDepth(t *testing.T) {
	const size, depth, budget = 4 << 20, 5000, 64 << 20
	input := nestedArray(depth, strings.Repeat("x", size))
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	text := arrayText(input)
	runtime.ReadMemStats(&after)
	if want := depth + 1 + size; len(text) != want {
		t.Fatalf("text of %d bytes, want %d", len(text), want)
	}
	if spent := after.TotalAlloc - before.TotalAlloc; spent > budget {
		t.Fatalf("allocated %d bytes for a text of %d", spent, len(text))
	}
}

func TestArrayTextIsArrayToString(t *testing.T) {
	for want, input := range map[string][]any{
		"":         {},
		",":        {nil, nil},
		"1,a,true": {float64(1), "a", true},
		"1,2,3":    {float64(1), []any{float64(2), []any{float64(3)}}},
		",,x":      {"", []any{"", []any{"x"}}},
		"a,,b":     {"a", []any{}, "b"},
		"x,":       {"x", nil},
	} {
		if got := arrayText(input); got != want {
			t.Errorf("arrayText(%v) = %q, want %q", input, got, want)
		}
	}
	if got := arrayText([]any{map[string]any{}}); got != "[object Object]" {
		t.Errorf("object: %q", got)
	}
}

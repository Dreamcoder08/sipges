package domain

import (
	"encoding/json"
	"testing"
)

// TestHistoryLimit pins IrsaHistoryQuery's coercion: the values below are what
// `z.coerce.number().int().default(50)` gave on Node 26 (FAIL = 422), negatives meaning all.
func TestHistoryLimit(t *testing.T) {
	const fail, all = int64(-100), int64(-200)
	for _, c := range []struct {
		raw     string
		present bool
		want    int64
	}{
		{"", false, 50}, {"", true, 0}, {"  ", true, 0}, {"abc", true, fail}, {"1.5", true, fail},
		{"1.0", true, 1}, {" 7 ", true, 7}, {"0x10", true, 16}, {"-0x10", true, fail}, {"0b11", true, 3},
		{"0o7", true, 7}, {"1e2", true, 100}, {"5e-1", true, fail}, {"Infinity", true, fail},
		{"-1", true, all}, {"-0", true, 0}, {"9007199254740993", true, fail},
		{"9007199254740991", true, 9007199254740991}, {"1e21", true, fail}, {"\u00a012\ufeff", true, 12},
		{"+5", true, 5}, {"1_0", true, fail}, {".5e1", true, 5}, {"5.", true, 5}, {"null", true, fail},
		{"1e400", true, fail},
	} {
		limit, ok := HistoryLimit(c.raw, c.present)
		got := fail
		switch {
		case ok && limit == nil:
			got = all
		case ok:
			got = *limit
		}
		if got != c.want {
			t.Errorf("HistoryLimit(%q, %v) = %d, want %d", c.raw, c.present, got, c.want)
		}
	}
}

func TestActivePhase(t *testing.T) {
	phase := func(s string) *string { return &s }
	for _, c := range []struct {
		phase   *string
		weights string
		want    bool
	}{
		{nil, `{"G":1}`, false}, {phase(""), `{"G":1}`, false}, {phase("cierre"), "", false},
		{phase("cierre"), "null", false}, {phase("cierre"), "0", false}, {phase("cierre"), `""`, false},
		{phase("cierre"), `{}`, true}, {phase("cierre"), `{"G":1}`, true},
	} {
		if _, ok := ActivePhase(c.phase, json.RawMessage(c.weights)); ok != c.want {
			t.Errorf("ActivePhase(%v, %s) = %v", c.phase, c.weights, ok)
		}
	}
	p, _ := ActivePhase(phase("otra"), json.RawMessage(`{"G":1}`))
	got, err := p.Decorate(json.RawMessage(`{"irsa":1,"notes":["a"]}`))
	want := `{"irsa":1,"notes":["a","Pesos de la fase undefined del proyecto (SIPGES), preliminares hasta su validación."],"phase":{"id":"otra"}}`
	if err != nil || string(got) != want {
		t.Fatalf("Decorate = %s, %v", got, err)
	}
}

func TestAppendMember(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{`{}`, `{"_id":"x"}`},
		{" { \"a\" : 1 } ", `{"a" : 1,"_id":"x"}`},
		{`{"_id":"p","b":2}`, `{"_id":"p","b":2,"_id":"x"}`},
	} {
		got, err := AppendMember(json.RawMessage(c.in), "_id", json.RawMessage(`"x"`))
		if err != nil || string(got) != c.want {
			t.Errorf("AppendMember(%s) = %s, %v", c.in, got, err)
		}
	}
	if _, err := AppendMember(json.RawMessage(`[1]`), "_id", json.RawMessage(`"x"`)); err == nil {
		t.Error("an array is not an object")
	}
}

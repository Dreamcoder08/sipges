package domain

import (
	"bytes"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
)

// storedTexts are JSON texts as PostgreSQL writes them, plus every case where encoding/json and
// the fast parser differ (invalid UTF-8, lone surrogate escapes) and malformed text.
var storedTexts = []string{
	`{}`, `[]`, `{"a": 1, "b": "x"}`, `[{"module":"Eventos","id":"EVE-1","payload":{"Fecha": "2026-01-15", "_id": "x"}}]`,
	`{"10": 1, "2": 2, "a": 3, "0": 4, "01": 5, "4294967294": 6, "4294967295": 7}`,
	`{"k": "tab\tnew\nline \"q\" \\ \/ \u0001 \u00e9 é 💡"}`, `{"n": [-0, 0.5, 1e400, -1e400, 1e-400, 123456789012345678901234567890]}`,
	`{"a": {"a": {"a": [true, false, null]}}}`, `{"dup": 1, "dup": 2}`, `{"pair": "\ud83d\udca1"}`, `{"PAIR": "\uD83D\uDCA1"}`,
	`{"lone": "\ud800"}`, `{"lone": "x\udfff"}`, `{"esc": "\\ud800"}`, "{\"bad\": \"\xff\xfe\"}", "{\"wtf\": \"\xed\xa0\x80\"}",
	` {"space": 1} `, `{"a": 1} x`, `{"a": 01}`, `{"a": 1.}`, `{"a": "unterminated}`, `{"a" 1}`, `[1,]`, ``, `nul`, `"str"`, `12`,
	`{"ctl": "` + "\x01" + `"}`, `{"big": 1E+2, "neg": -1.5e-3}`, `{"u": "\u00"}`,
}

func sameParse(t *testing.T, text string) {
	t.Helper()
	want, wantErr := Parse([]byte(text))
	got, gotErr := ParseStored(text)
	if (wantErr == nil) != (gotErr == nil) {
		t.Fatalf("%q: error %v, want %v", text, gotErr, wantErr)
	}
	if wantErr == nil && !bytes.Equal(Stringify(got), Stringify(want)) {
		t.Fatalf("%q:\n got %s\nwant %s", text, Stringify(got), Stringify(want))
	}
	if wantErr != nil && gotErr.Error() != wantErr.Error() {
		t.Fatalf("%q: error %q, want %q", text, gotErr, wantErr)
	}
}

func TestParseStoredIsParse(t *testing.T) {
	t.Parallel()
	for _, text := range storedTexts {
		sameParse(t, text)
	}
	deep := strings.Repeat("[", MaxBodyDepth+1) + strings.Repeat("]", MaxBodyDepth+1)
	sameParse(t, deep)
}

func TestParseStoredObject(t *testing.T) {
	t.Parallel()
	if _, err := ParseStoredObject(`[1]`); !errors.Is(err, ErrNotObject) {
		t.Fatalf("array: %v", err)
	}
	if _, err := ParseStoredObject(`{`); err == nil {
		t.Fatal("malformed text parsed")
	}
	o, err := ParseStoredObject(`{"b": 1, "1": 2}`)
	if err != nil || fmt.Sprint(o.Keys()) != "[1 b]" {
		t.Fatalf("keys %v, err %v", o.Keys(), err)
	}
}

func FuzzParseStored(f *testing.F) {
	for _, text := range storedTexts {
		f.Add(text)
	}
	f.Fuzz(func(t *testing.T, text string) { sameParse(t, text) })
}

func TestAppendStringFastPathIsStringify(t *testing.T) {
	t.Parallel()
	for _, s := range []string{"", "plain", "é 💡 ñ", "\u2028", "\ufffd", "a\"b", "a\\b", "\x01", "\x7f", "\xff", "\xed\xa0\x80", "x\xed\xbf\xbfy", "\xe2\x82"} {
		got := appendString(nil, s)
		// The escaping loop alone, reached through a string that never takes the fast path.
		forced := appendString(nil, s+"\x00")
		want := slices.Concat(forced[:len(forced)-len(`\u0000"`)], []byte{'"'})
		if !bytes.Equal(got, want) {
			t.Errorf("%q: got %s, want %s", s, got, want)
		}
	}
}

func TestAppendSpreadIsCloneAndSet(t *testing.T) {
	t.Parallel()
	for _, text := range []string{`{}`, `{"a": 1}`, `{"_id": "old", "a": [1, {"b": 2}]}`, `{"_updated_at": 1, "z": null}`,
		`{"2": 1, "a": 2, "_id": 3, "_updated_at": 4}`, `{"k1":1,"k2":2,"k3":3,"k4":4,"k5":5,"k6":6,"k7":7,"k8":8,"k9":9,"k10":10,"k11":11,"k12":12,"k13":13,"k14":14,"k15":15,"k16":16,"k17":17,"_id":0}`} {
		o, err := ParseObject([]byte(text))
		if err != nil {
			t.Fatal(err)
		}
		for _, keys := range [][]string{{"_id", "_updated_at"}, {"_id"}, {"7", "_id"}, {}} {
			values := []string{"ID-1", "2026-01-01T00:00:00Z"}[:min(len(keys), 2)]
			if len(keys) == 2 && keys[0] == "7" {
				values = []string{"seven", "ID"}
			}
			want := o.Clone()
			for i, k := range keys {
				want.Set(k, values[i])
			}
			got := AppendSpread([]byte("prefix,"), o, keys, values)
			if w := append([]byte("prefix,"), Stringify(want)...); !bytes.Equal(got, w) {
				t.Errorf("%s + %v:\n got %s\nwant %s", text, keys, got, w)
			}
			if !bytes.Equal(Stringify(o), Stringify(mustParse(t, text))) {
				t.Errorf("%s: AppendSpread changed its object", text)
			}
		}
	}
}

func mustParse(t *testing.T, text string) *Object {
	t.Helper()
	o, err := ParseObject([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	return o
}

func TestObjectPastLinearKeys(t *testing.T) {
	t.Parallel()
	o := NewObject()
	for i := range 3 * linearKeys {
		o.Set(fmt.Sprintf("k%d", i), float64(i))
	}
	o.Set("5", "index")
	o.Set("k0", "again")
	c := o.Clone()
	c.Set("k1", "clone only")
	for i := range 3 * linearKeys {
		v, ok := o.Get(fmt.Sprintf("k%d", i))
		want := any(float64(i))
		if i == 0 {
			want = "again"
		}
		if !ok || v != want {
			t.Fatalf("k%d = %v, %v", i, v, ok)
		}
	}
	if o.Keys()[0] != "5" || len(o.Keys()) != 3*linearKeys+1 {
		t.Fatalf("keys %v", o.Keys())
	}
	if v, _ := o.Get("k1"); v != float64(1) {
		t.Fatalf("the clone changed the original: %v", v)
	}
	if _, ok := o.Get("missing"); ok {
		t.Fatal("missing key found")
	}
}

package desktopsnapshot

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// vectors.json is what the Node scripts compute (testdata/vectors.mjs): the Go port must give the
// same keyed hashes, String(), Number(), JSON.stringify text and key order for every text.
func readVectors(t *testing.T, raw []byte) (string, []*Object) {
	t.Helper()
	parsed, err := ParseJSON(DecodeText(raw))
	if err != nil {
		t.Fatalf("vectors.json: %v", err)
	}
	root := parsed.(*Object)
	var list []*Object
	for _, v := range root.Get("vectors").([]any) {
		list = append(list, v.(*Object))
	}
	return root.Get("salt").(string), list
}

func TestNodeVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	salt, vectors := readVectors(t, raw)
	if len(vectors) < 25 {
		t.Fatalf("only %d vectors", len(vectors))
	}
	h := Keyed(salt)
	for _, v := range vectors {
		text := v.Get("text").(string)
		value, err := ParseJSON(text)
		if err != nil {
			t.Fatalf("%s: %v", text, err)
		}
		check := func(what string, got any) {
			t.Helper()
			want := v.Get(what)
			if !StrictEqual(got, want) {
				t.Errorf("%s: %s = %q, Node %q", text, what, got, want)
			}
		}
		check("hash", h(value))
		check("string", ToString(value))
		check("number", NumberString(ToNumber(value)))
		s, _ := Stringify(value, "")
		check("stringify", s)
		indented, ok := Stringify(value, "  ")
		if ok {
			check("indented", indented)
		}
		if o, isObject := value.(*Object); isObject {
			want := v.Get("keys").([]any)
			got := o.Keys()
			if len(got) != len(want) {
				t.Fatalf("%s: keys %v, Node %v", text, got, want)
			}
			for i := range got {
				if got[i] != want[i] {
					t.Errorf("%s: keys %v, Node %v", text, got, want)
				}
			}
			check("content", ContentHash(h, o))
			check("attachments", ExportRowHash(h, "attachments", o))
		}
	}
}

// The committed vectors are what this checkout's Node scripts compute, when Node is here.
func TestNodeVectorsAreCurrent(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH; vectors.json is checked as committed")
	}
	out, err := exec.Command(node, filepath.Join("testdata", "vectors.mjs")).Output()
	if err != nil {
		t.Fatalf("vectors.mjs: %v", err)
	}
	committed, err := os.ReadFile(filepath.Join("testdata", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	// Compared as values: Prettier formats the committed file.
	same := func(raw []byte) string {
		v, err := ParseJSON(DecodeText(raw))
		if err != nil {
			t.Fatal(err)
		}
		text, _ := Stringify(v, "")
		return text
	}
	if same(committed) != same(out) {
		t.Fatal("testdata/vectors.json is stale: regenerate it with testdata/vectors.mjs, then Prettier")
	}
}

func TestDecodeTextLikeTextDecoder(t *testing.T) {
	cases := map[string]string{
		"\xEF\xBB\xBFok":    "ok",
		"a\xE2\x82b":        "a�b",
		"\xED\xA0\x80":      "���",
		"\xF0\x9F\x98":      "�",
		"\xC0\xAF":          "��",
		"\xF4\x90\x80\x80":  "����",
		"ok\xFF":            "ok�",
		"\xE0\x80\x80":      "���",
		"\xF0\x9F\x98\x80!": "😀!",
	}
	for in, want := range cases {
		if got := DecodeText([]byte(in)); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

func TestParseJSONRefusesWhatJSONParseRefuses(t *testing.T) {
	for _, text := range []string{"", "01", "1.", ".5", "+1", "[1,]", `{"a":1,}`, "'x'", "\"\x01\"", `"\x"`, "NaN", "[1] x", `"\u12"`, " 1"} {
		if _, err := ParseJSON(text); err == nil {
			t.Errorf("%q parsed", text)
		}
	}
	if _, err := ParseJSON(" \t\r\n[ 1 , {\"a\" : -0.5e+2 } ] "); err != nil {
		t.Error(err)
	}
}

func TestEncodeURIComponent(t *testing.T) {
	got, err := EncodeURIComponent("EV/1 ?&=#+ñ!~*'()._-")
	if err != nil || got != "EV%2F1%20%3F%26%3D%23%2B%C3%B1!~*'()._-" {
		t.Fatalf("%q %v", got, err)
	}
	lone, _ := ParseJSON(`"\ud800"`)
	if _, err := EncodeURIComponent(lone.(string)); err == nil {
		t.Fatal("a lone surrogate was encoded")
	}
}

func TestToNumberLikeNumber(t *testing.T) {
	cases := map[string]string{
		"": "0", "\t12\n": "12", "1e3": "1000", "0x10": "16", "-0x10": "NaN", "1_0": "NaN", "inf": "NaN",
		"Infinity": "Infinity", "1.": "1", ".5": "0.5", "1.e2": "100", "+-1": "NaN", "\uFEFF7\u2028": "7",
	}
	for in, want := range cases {
		if got := NumberString(ToNumber(in)); got != want {
			t.Errorf("Number(%q) = %s, want %s", in, got, want)
		}
	}
	if !strings.HasPrefix(NumberString(ToNumber(Undefined)), "NaN") {
		t.Error("Number(undefined) is not NaN")
	}
}

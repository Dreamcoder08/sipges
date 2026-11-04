package domain_test

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/domain"
	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// filesFixture is testdata/files.json, recorded from the TypeScript domain and service by
// testdata/generate-files.mjs on synthetic inputs.
type filesFixture struct {
	Payloads []struct {
		Payload string `json:"payload"`
		Scope   string `json:"scope"`
		Project struct {
			ProjectID   string `json:"projectId"`
			ProjectName string `json:"projectName"`
		} `json:"project"`
		Links map[string]string `json:"links"`
	} `json:"payloads"`
	Previews map[string]struct {
		Count  int   `json:"count"`
		Tail   []int `json:"tail"`
		Result struct {
			Kind      string `json:"kind"`
			Truncated bool   `json:"truncated"`
			Pages     []struct {
				Length int      `json:"length"`
				Tail   []uint16 `json:"tail"`
			} `json:"pages"`
		} `json:"result"`
	} `json:"previews"`
	Decodes map[string]struct {
		Bytes []int    `json:"bytes"`
		Strip []uint16 `json:"strip"`
		Keep  []uint16 `json:"keep"`
	} `json:"decodes"`
}

func loadFiles(t *testing.T) filesFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/files.json")
	if err != nil {
		t.Fatal(err)
	}
	var f filesFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func toBytes(ints []int) []byte {
	b := make([]byte, len(ints))
	for i, v := range ints {
		b[i] = byte(v)
	}
	return b
}

// units is a Go string as JavaScript code units; a WTF-8 lone surrogate (as Slice16 keeps it)
// is one unit.
func units(s string) []uint16 {
	var out []uint16
	for i := 0; i < len(s); {
		if i+2 < len(s) && s[i] == 0xed && s[i+1] >= 0xa0 && s[i+1] <= 0xbf {
			out = append(out, 0xd000|uint16(s[i+1]&0x3f)<<6|uint16(s[i+2]&0x3f))
			i += 3
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		out = append(out, utf16.Encode([]rune{r})...)
		i += size
	}
	return out
}

// canonical decodes JSON keeping numbers as written, for comparing what jsonb would store.
func canonical(t *testing.T, s string) any {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader([]byte(s)))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("%s: %v", s, err)
	}
	return v
}

func TestProjectOfAndLinkIntoPayloadMatchTypeScript(t *testing.T) {
	f := loadFiles(t)
	if len(f.Payloads) < 30 {
		t.Fatalf("only %d payload cases", len(f.Payloads))
	}
	link := domain.Link{ID: "ADJ-0123456789AB", FileName: "acta.pdf", DocumentType: "Acta <b>", Verification: "A - Verificada"}
	// A lone surrogate reaches the JSON as JSON.stringify writes it, for PostgreSQL to refuse.
	cut, err := domain.LinkIntoPayload(domain.Payload{}, "alertas", domain.Link{ID: "x", DocumentType: js.Slice16("a😀", 2)})
	if err != nil || !bytes.Contains(cut, []byte(`"tipo":"a\ud83d"`)) {
		t.Errorf("%s %v", cut, err)
	}
	for _, c := range f.Payloads {
		p, err := domain.ParsePayload([]byte(c.Payload))
		if err != nil {
			t.Fatal(err)
		}
		id, name := domain.ProjectOf(p, c.Scope)
		if id != c.Project.ProjectID || name != c.Project.ProjectName {
			t.Errorf("%s in %s: project %q %q, TypeScript %q %q", c.Payload, c.Scope, id, name, c.Project.ProjectID, c.Project.ProjectName)
		}
		for slug, want := range c.Links {
			got, err := domain.LinkIntoPayload(p, slug, link)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(canonical(t, string(got)), canonical(t, want)) {
				t.Errorf("%s as %s:\ngot  %s\nwant %s", c.Payload, slug, got, want)
			}
		}
	}
}

func TestViewerTextMatchesTypeScript(t *testing.T) {
	f := loadFiles(t)
	for name, c := range f.Previews {
		data := append(bytes.Repeat([]byte("a"), c.Count), toBytes(c.Tail)...)
		pages := []string{domain.PlainText(data)}
		if !domain.HasText(pages) {
			if c.Result.Kind != "no_text" {
				t.Errorf("%s: no_text, TypeScript %s", name, c.Result.Kind)
			}
			continue
		}
		clipped, truncated := domain.Clip(pages)
		if c.Result.Kind != "text" || truncated != c.Result.Truncated || len(clipped) != len(c.Result.Pages) {
			t.Errorf("%s: text %v %d pages, TypeScript %+v", name, truncated, len(clipped), c.Result)
			continue
		}
		for i, p := range clipped {
			u := units(string(p))
			want := c.Result.Pages[i]
			if len(u) != want.Length || !reflect.DeepEqual(u[max(0, len(u)-8):], want.Tail) {
				t.Errorf("%s page %d: %d units ending %v, TypeScript %d ending %v", name, i, len(u), u[max(0, len(u)-8):], want.Length, want.Tail)
			}
			// Text16 writes a lone surrogate as JSON.stringify does.
			if name == "cut_in_a_pair" {
				b, _ := json.Marshal(p)
				if !bytes.HasSuffix(b, []byte(`a\ud83d"`)) {
					t.Errorf("JSON %s", b[len(b)-12:])
				}
			}
		}
	}
}

func TestDecodeUTF8MatchesTextDecoder(t *testing.T) {
	f := loadFiles(t)
	for name, c := range f.Decodes {
		b := toBytes(c.Bytes)
		if got := units(domain.DecodeUTF8(b, true)); !reflect.DeepEqual(got, c.Strip) && (len(got) != 0 || len(c.Strip) != 0) {
			t.Errorf("%s (BOM dropped): %v, TextDecoder %v", name, got, c.Strip)
		}
		if got := units(domain.DecodeUTF8(b, false)); !reflect.DeepEqual(got, c.Keep) && (len(got) != 0 || len(c.Keep) != 0) {
			t.Errorf("%s (BOM kept): %v, TextDecoder %v", name, got, c.Keep)
		}
	}
}

func TestStorageKeyLayout(t *testing.T) {
	// sha256("SIPGES/PRJ-SECHURA") starts with these 24 hex characters (Node's createHash).
	if got := domain.TenantPrefix("SIPGES/PRJ-SECHURA"); got != "b00b9b3deab5a1b1ddca8af8" {
		t.Fatal(got)
	}
	key := domain.StorageKey("SIPGES/PRJ-SECHURA", "0123456789ABCDEF0123456789abcdef", "acta.pdf")
	if key != domain.TenantPrefix("SIPGES/PRJ-SECHURA")+"/0123456789abcdef0123456789abcdef_acta.pdf" || !domain.ValidObjectKey(key) {
		t.Errorf("key %q", key)
	}
	if domain.TenantPrefix("SIPGES/PRJ-SECHURA") == domain.TenantPrefix("ACME/NORTE") {
		t.Error("tenants share a prefix")
	}
	for _, bad := range []string{"", "../x", "aaaaaaaaaaaaaaaaaaaaaaaa/../x", "aaaaaaaaaaaaaaaaaaaaaaaa/a/b", "AAAAAAAAAAAAAAAAAAAAAAAA/x", "aaaaaaaaaaaaaaaaaaaaaaaa/x\n"} {
		if domain.ValidObjectKey(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestSliceStoredReplacesACutPair(t *testing.T) {
	for _, c := range []struct {
		in   string
		n    int
		want string
	}{
		{"abc", 2, "ab"},
		{"a😀", 2, "a\ufffd"},
		{"a😀", 3, "a😀"},
		{"😀😀", 3, "😀\ufffd"},
		{"ñandú", 10, "ñandú"},
	} {
		if got := domain.SliceStored(c.in, c.n); got != c.want {
			t.Errorf("%q[:%d] = %q, want %q", c.in, c.n, got, c.want)
		}
	}
}

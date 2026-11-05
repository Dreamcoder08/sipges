package domain

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The fixture records the TypeScript domain's answers (testdata/generate.mjs). A wider run on
// a scratch file goes through PRIVACY_FIXTURE_FILE.
type fixture struct {
	Placeholders map[string]string `json:"placeholders"`
	Policies     []struct {
		Slug   string `json:"slug"`
		Fields []struct {
			Field, Kind, Entity, Why string
		} `json:"fields"`
	} `json:"policies"`
	StoredModules map[string]string `json:"storedModules"`
	TitleFields   map[string]string `json:"titleFields"`
	NameSources   []struct {
		Field  string `json:"field"`
		Entity string `json:"entity"`
		List   bool   `json:"list"`
	} `json:"nameSources"`
	Unicode        []string                     `json:"unicode"`
	Patterns       [][]string                   `json:"patterns"`
	Split          [][]any                      `json:"split"`
	Pseudonymisers map[string]pseudonymiserCase `json:"pseudonymisers"`
	Sanitise       []sanitiseCase               `json:"sanitise"`
}

type pseudonymiserCase struct {
	Key   string `json:"key"`
	Names []struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
	} `json:"names"`
	Scrub     [][]string `json:"scrub"`
	Pseudonym [][]string `json:"pseudonym"`
	KindOf    [][]any    `json:"kindOf"`
}

type sanitiseCase struct {
	Set     string `json:"set"`
	Records []struct {
		Module  string  `json:"module"`
		ID      string  `json:"id"`
		Title   *string `json:"title"`
		Date    *string `json:"date"`
		Marking *string `json:"marking"`
		Fields  [][]any `json:"fields"`
	} `json:"records"`
	Expected json.RawMessage `json:"expected"`
}

func load(t *testing.T) *fixture {
	t.Helper()
	path := os.Getenv("PRIVACY_FIXTURE_FILE")
	if path == "" {
		path = "../testdata/fixtures.json"
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var f fixture
	if err := decoder.Decode(&f); err != nil {
		t.Fatal(err)
	}
	return &f
}

var escapedSurrogate = regexp.MustCompile(`\\ud[89a-f][0-9a-f]{2}`)

// unmark restores the lone surrogates the fixture holds as U+F0000 + the unit, because JSON
// decoding would lose them, into the WTF-8 this package receives them in.
func unmark(s string) string {
	var out strings.Builder
	for _, r := range s {
		if r >= 0xfd800 && r <= 0xfdfff {
			out.WriteString(fromUnits([]uint16{uint16(r - 0xf0000)}))
			continue
		}
		out.WriteRune(r)
	}
	return out.String()
}

// marked writes a marshalled lone surrogate the way the fixture holds it.
func marked(raw []byte) []byte {
	return escapedSurrogate.ReplaceAllFunc(raw, func(escape []byte) []byte {
		unit, err := strconv.ParseUint(string(escape[2:]), 16, 16)
		if err != nil {
			panic(err)
		}
		return []byte(string(rune(unit) + 0xf0000))
	})
}

func macFor(key string) Mac {
	return func(message string) string {
		h := hmac.New(sha256.New, []byte(key))
		h.Write([]byte(message))
		return hex.EncodeToString(h.Sum(nil))
	}
}

func unmarkPtr(s *string) *string {
	if s == nil {
		return nil
	}
	clean := unmark(*s)
	return &clean
}

func build(c pseudonymiserCase) *Pseudonymiser {
	names := make([]KnownName, 0, len(c.Names))
	for _, n := range c.Names {
		names = append(names, KnownName{PseudonymKind(n.Kind), n.Name})
	}
	return NewPseudonymiser(macFor(c.Key), names)
}

func TestPoliciesMatchTypeScript(t *testing.T) {
	f := load(t)
	if len(f.Policies) != len(FieldPolicies) {
		t.Fatalf("modules: %d, want %d", len(FieldPolicies), len(f.Policies))
	}
	for i, module := range f.Policies {
		got := FieldPolicies[i]
		if got.Slug != module.Slug || len(got.Fields) != len(module.Fields) {
			t.Fatalf("module %d: %s with %d fields, want %s with %d", i, got.Slug, len(got.Fields), module.Slug, len(module.Fields))
		}
		for j, want := range module.Fields {
			field := got.Fields[j]
			if field.Field != want.Field || string(field.Policy.Kind) != want.Kind ||
				string(field.Policy.Entity) != want.Entity || field.Policy.Why != want.Why {
				t.Errorf("%s: %+v, want %+v", module.Slug, field, want)
			}
		}
	}
	if !reflect.DeepEqual(StoredModules, f.StoredModules) {
		t.Errorf("stored modules differ: %v", StoredModules)
	}
	if !reflect.DeepEqual(TitleFields, f.TitleFields) {
		t.Errorf("title fields differ: %v", TitleFields)
	}
	if len(NameSources) != len(f.NameSources) {
		t.Fatalf("name sources: %d, want %d", len(NameSources), len(f.NameSources))
	}
	for i, want := range f.NameSources {
		got := NameSources[i]
		if got.Field != want.Field || string(got.Entity) != want.Entity || got.List != want.List {
			t.Errorf("name source %d: %+v, want %+v", i, got, want)
		}
	}
	want := map[string]string{"email": PlaceholderEmail, "phone": PlaceholderPhone, "dni": PlaceholderDNI, "ruc": PlaceholderRUC}
	if !reflect.DeepEqual(f.Placeholders, want) {
		t.Errorf("placeholders: %v", f.Placeholders)
	}
}

func TestNoSensitiveFieldIsAllowed(t *testing.T) {
	for _, module := range FieldPolicies {
		for _, f := range module.Fields {
			if NeverAllowed.MatchString(f.Field) {
				t.Errorf("%s.%s must never be sent", module.Slug, f.Field)
			}
		}
	}
}

// Every code point folds and counts as a word character as in Node's Unicode.
func TestUnicodeTablesMatchNode(t *testing.T) {
	for block, want := range load(t).Unicode {
		hash := sha256.New()
		for cp := rune(block) << 12; cp < rune(block+1)<<12; cp++ {
			if cp >= 0xd800 && cp <= 0xdfff {
				continue
			}
			word := "-"
			if isWord(cp) {
				word = "w"
			}
			hash.Write(fmt.Appendf(nil, "%d %s %s\n", cp, FoldName("a"+string(cp)+"a"), word))
		}
		if got := hex.EncodeToString(hash.Sum(nil))[:16]; got != want {
			t.Errorf("block U+%X000: hash %s, want %s", block, got, want)
		}
	}
}

func TestScrubMatchesTypeScript(t *testing.T) {
	for _, c := range load(t).Patterns {
		if got := ScrubPatterns(unmark(c[0])); got != unmark(c[1]) {
			t.Errorf("ScrubPatterns(%q) = %q, want %q", c[0], got, c[1])
		}
		if got := ScrubTruncated(unmark(c[0])); got != unmark(c[2]) {
			t.Errorf("ScrubTruncated(%q) = %q, want %q", c[0], got, c[2])
		}
	}
}

func TestSplitListMatchesTypeScript(t *testing.T) {
	for _, c := range load(t).Split {
		want := make([]string, 0, len(c[1].([]any)))
		for _, item := range c[1].([]any) {
			want = append(want, unmark(item.(string)))
		}
		if got := SplitList(unmark(c[0].(string))); !reflect.DeepEqual(got, want) {
			t.Errorf("SplitList(%q) = %q, want %q", c[0], got, want)
		}
	}
}

func TestPseudonymiserMatchesTypeScript(t *testing.T) {
	for set, c := range load(t).Pseudonymisers {
		p := build(c)
		for _, s := range c.Scrub {
			if got := p.Scrub(unmark(s[0])); got != unmark(s[1]) {
				t.Errorf("%s: Scrub(%q) = %q, want %q", set, s[0], got, s[1])
			}
		}
		for _, s := range c.Pseudonym {
			if got := p.Pseudonym(PseudonymKind(s[0]), unmark(s[1])); got != s[2] {
				t.Errorf("%s: Pseudonym(%s, %q) = %q, want %q", set, s[0], s[1], got, s[2])
			}
		}
		for _, s := range c.KindOf {
			kind, ok := p.KindOf(unmark(s[0].(string)))
			if want, known := s[1].(string); known != ok || want != string(kind) {
				t.Errorf("%s: KindOf(%q) = %q %v, want %v", set, s[0], kind, ok, s[1])
			}
		}
	}
}

func TestSanitiseMatchesTypeScript(t *testing.T) {
	f := load(t)
	for i, c := range f.Sanitise {
		records := make([]RawRecord, 0, len(c.Records))
		for _, r := range c.Records {
			fields := make([]RawField, 0, len(r.Fields))
			for _, pair := range r.Fields {
				value := pair[1]
				if text, ok := value.(string); ok {
					value = unmark(text)
				}
				fields = append(fields, RawField{pair[0].(string), value})
			}
			records = append(records, RawRecord{r.Module, r.ID, unmarkPtr(r.Title), unmarkPtr(r.Date), r.Marking, fields})
		}
		sanitised, report := SanitiseRecords(build(f.Pseudonymisers[c.Set]), records)
		got, err := json.Marshal(map[string]any{"records": sanitised, "report": map[string]any{
			"records": report.Records, "sent": report.Sent, "dropped": report.Dropped,
			"withheld": report.Withheld, "droppedFields": report.DroppedFields,
		}})
		if err != nil {
			t.Fatal(err)
		}
		// Fields keep their order, which DeepEqual on decoded maps cannot see.
		if a, b := canonical(t, marked(got)), canonical(t, c.Expected); a != b {
			t.Errorf("case %d (%s):\n got %s\nwant %s", i, strconv.Quote(c.Set), a, b)
		}
		for j, record := range sanitised {
			wantOrder := fieldOrder(t, c.Expected, j)
			gotOrder := make([]string, 0, len(record.Fields))
			for _, field := range record.Fields {
				gotOrder = append(gotOrder, field.Name)
			}
			if !reflect.DeepEqual(gotOrder, wantOrder) {
				t.Errorf("case %d record %d: fields %q, want %q", i, j, gotOrder, wantOrder)
			}
		}
	}
}

// canonical is the JSON with sorted keys and numbers by value: the formatter of the fixture writes
// 1e21 where JSON.stringify writes 1e+21.
func canonical(t *testing.T, raw []byte) string {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	out, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// fieldOrder reads the field names of record index in the order the JSON holds them.
func fieldOrder(t *testing.T, raw []byte, index int) []string {
	t.Helper()
	var doc struct {
		Records []struct {
			Fields json.RawMessage `json:"fields"`
		} `json:"records"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(doc.Records[index].Fields))
	names := []string{}
	if _, err := decoder.Token(); err != nil { // {
		t.Fatal(err)
	}
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, key.(string))
		var skip json.RawMessage
		if err := decoder.Decode(&skip); err != nil {
			t.Fatal(err)
		}
	}
	return names
}

package domain

import (
	"bytes"
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
)

// fixtures.json is recorded from the TypeScript domain by ../testdata/generate.mjs.
type fixtures struct {
	Catalog string `json:"catalog"`
	Rules   string `json:"rules"`
	Fold    []struct {
		Text string `json:"text"`
		Out  string `json:"out"`
	} `json:"fold"`
	Terms []struct {
		Raw   string   `json:"raw"`
		Terms []string `json:"terms"`
		Query *string  `json:"query"`
	} `json:"terms"`
	Excerpts []struct {
		Payload   string   `json:"payload"`
		Terms     []string `json:"terms"`
		Preferred []string `json:"preferred"`
		Out       string   `json:"out"`
	} `json:"excerpts"`
	Summaries []struct {
		Slug    string `json:"slug"`
		Payload string `json:"payload"`
		Title   string `json:"title"`
		Out     string `json:"out"`
	} `json:"summaries"`
	Days []struct {
		Value string  `json:"value"`
		End   bool    `json:"end"`
		Out   *string `json:"out"`
	} `json:"days"`
}

func load(t *testing.T) fixtures {
	t.Helper()
	raw, err := os.ReadFile("../testdata/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

// stringify is JSON.stringify for the values these tests compare: no HTML escaping.
func stringify(t *testing.T, v any) string {
	t.Helper()
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		t.Fatal(err)
	}
	return strings.TrimSuffix(b.String(), "\n")
}

func payloadOf(t *testing.T, raw string) Payload {
	t.Helper()
	p, err := DecodePayload([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestCatalogMatchesTypeScript(t *testing.T) {
	f := load(t)
	if got := stringify(t, Catalog()); got != f.Catalog {
		t.Fatalf("catalog\n got %s\nwant %s", got, f.Catalog)
	}
	type rule struct {
		LinkType       string `json:"linkType"`
		Holder         string `json:"holder"`
		Field          string `json:"field"`
		Target         string `json:"target"`
		Match          string `json:"match"`
		HolderIsSource bool   `json:"holderIsSource"`
	}
	rules := make([]rule, 0, len(InferenceRules))
	for _, r := range InferenceRules {
		rules = append(rules, rule(r))
	}
	if got := stringify(t, rules); got != f.Rules {
		t.Fatalf("rules\n got %s\nwant %s", got, f.Rules)
	}
}

func TestFoldTextMatchesTypeScript(t *testing.T) {
	for _, c := range load(t).Fold {
		if got := FoldText(c.Text); got != c.Out {
			t.Errorf("FoldText(%q) = %q, want %q", c.Text, got, c.Out)
		}
	}
}

func TestSearchTermsMatchTypeScript(t *testing.T) {
	for _, c := range load(t).Terms {
		terms := SearchTerms(c.Raw)
		if !slices.Equal(terms, c.Terms) && (len(terms) != 0 || len(c.Terms) != 0) {
			t.Errorf("SearchTerms(%q) = %q, want %q", c.Raw, terms, c.Terms)
		}
		got := ToPrefixQuery(terms)
		if (got == nil) != (c.Query == nil) || (got != nil && *got != *c.Query) {
			t.Errorf("ToPrefixQuery(%q) = %v, want %v", terms, got, c.Query)
		}
	}
}

func TestMatchExcerptMatchesTypeScript(t *testing.T) {
	for _, c := range load(t).Excerpts {
		got := stringify(t, MatchExcerpt(payloadOf(t, c.Payload), c.Terms, c.Preferred))
		if got != c.Out {
			t.Errorf("MatchExcerpt(%s, %q)\n got %s\nwant %s", c.Payload, c.Terms, got, c.Out)
		}
	}
}

func TestSummarizeMatchesTypeScript(t *testing.T) {
	for _, c := range load(t).Summaries {
		objectType, ok := ObjectTypeForSlug(c.Slug)
		if !ok {
			t.Fatalf("unknown slug %q", c.Slug)
		}
		payload := payloadOf(t, c.Payload)
		if got := stringify(t, TitleOf(objectType, "ID-1", payload)); got != c.Title {
			t.Errorf("TitleOf(%s, %s)\n got %s\nwant %s", c.Slug, c.Payload, got, c.Title)
		}
		got := stringify(t, Summarize(objectType, "ID-1", payload, "interno", nil))
		if got != c.Out {
			t.Errorf("Summarize(%s, %s)\n got %s\nwant %s", c.Slug, c.Payload, got, c.Out)
		}
	}
}

func TestDayBoundMatchesTypeScript(t *testing.T) {
	for _, c := range load(t).Days {
		got, ok := DayBound(c.Value, c.End)
		if ok != (c.Out != nil) || (ok && got != *c.Out) {
			t.Errorf("DayBound(%q, %v) = %q %v, want %v", c.Value, c.End, got, ok, c.Out)
		}
	}
}

func TestUnitsSliceKeepsLoneSurrogatesAsJSONStringifyWritesThem(t *testing.T) {
	u := UnitsOf("a😀b")
	if got := stringify(t, u.Slice(0, 2).Text()); got != `"a\ud83d"` {
		t.Fatalf("high half: %s", got)
	}
	if got := stringify(t, u.Slice(2, 4).Text()); got != `"\ude00b"` {
		t.Fatalf("low half: %s", got)
	}
	if got := u.Slice(0, 2).String(); got != "a�" {
		t.Fatalf("lossy: %q", got)
	}
}

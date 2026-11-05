package domain_test

import (
	"encoding/json"
	"os"
	"slices"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The domain rules against what testdata/domain.mjs recorded from Node and the TypeScript
// domain: `new URL`, `Date.parse`, parseFeed, matchedKeywords and feedUrlProblem.

type item struct {
	Key         string  `json:"key"`
	Title       string  `json:"title"`
	Link        string  `json:"link"`
	Summary     string  `json:"summary"`
	PublishedAt *string `json:"publishedAt"`
}

type fixture struct {
	URLs []struct {
		Input    string `json:"input"`
		OK       bool   `json:"ok"`
		Protocol string `json:"protocol"`
		Username string `json:"username"`
		Password string `json:"password"`
		Hostname string `json:"hostname"`
		Port     string `json:"port"`
		Href     string `json:"href"`
	} `json:"urls"`
	Dates []struct {
		Input string  `json:"input"`
		ISO   *string `json:"iso"`
	} `json:"dates"`
	Feeds []struct {
		XML   string `json:"xml"`
		Items []item `json:"items"`
	} `json:"feeds"`
	Keywords []struct {
		Item     struct{ Title, Summary string } `json:"item"`
		Keywords []string                        `json:"keywords"`
		Matched  []string                        `json:"matched"`
	} `json:"keywords"`
	Problems []struct {
		Input   string  `json:"input"`
		Problem *string `json:"problem"`
	} `json:"problems"`
}

func load(t *testing.T) fixture {
	t.Helper()
	data, err := os.ReadFile("../testdata/domain.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

// unported are inputs the port reads less than Node and fails closed on: hosts that need IDNA.
var unported = map[string]bool{"https://ñandú.example/": true}

func TestParseURLMatchesNode(t *testing.T) {
	for _, c := range load(t).URLs {
		got, ok := domain.ParseURL(c.Input)
		if unported[c.Input] {
			if ok {
				t.Errorf("%q: parsed, want the fail-closed refusal", c.Input)
			}
			continue
		}
		if ok != c.OK {
			t.Errorf("%q: ok %v, Node %v", c.Input, ok, c.OK)
			continue
		}
		if !ok {
			continue
		}
		want := domain.URL{Protocol: c.Protocol, Username: c.Username, Password: c.Password, Hostname: c.Hostname, Port: c.Port, Href: c.Href}
		if c.Protocol != "https:" && c.Protocol != "http:" && c.Protocol != "ws:" && c.Protocol != "ftp:" {
			if got.Protocol != want.Protocol {
				t.Errorf("%q: protocol %q, Node %q", c.Input, got.Protocol, want.Protocol)
			}
			continue // only parse success and the scheme are read from other schemes
		}
		if got != want {
			t.Errorf("%q:\n got  %+v\n want %+v", c.Input, got, want)
		}
	}
}

func TestParseDateMatchesNode(t *testing.T) {
	for _, c := range load(t).Dates {
		got, ok := domain.ParseDateJS(c.Input)
		var iso *string
		if ok {
			s := domain.ISOString(got)
			iso = &s
		}
		switch {
		case iso == nil && c.ISO == nil:
		case iso == nil || c.ISO == nil || *iso != *c.ISO:
			t.Errorf("%q: %v, Node %v", c.Input, deref(iso), deref(c.ISO))
		}
	}
}

func deref(s *string) string {
	if s == nil {
		return "null"
	}
	return *s
}

func TestParseFeedMatchesTypeScript(t *testing.T) {
	for i, c := range load(t).Feeds {
		got := domain.ParseFeed(c.XML)
		if len(got) != len(c.Items) {
			t.Errorf("feed %d: %d items, TypeScript %d", i, len(got), len(c.Items))
			continue
		}
		for j, want := range c.Items {
			// A lone surrogate is WTF-8 here; the fixture's JSON decoder reads it as U+FFFD.
			g := item{Key: records.WellFormed(got[j].Key), Title: records.WellFormed(got[j].Title), Link: got[j].Link,
				Summary: records.WellFormed(got[j].Summary), PublishedAt: got[j].PublishedAt}
			if g.Key != want.Key || g.Title != want.Title || g.Link != want.Link || g.Summary != want.Summary ||
				deref(g.PublishedAt) != deref(want.PublishedAt) {
				t.Errorf("feed %d item %d:\n got  %+v %s\n want %+v %s", i, j, g, deref(g.PublishedAt), want, deref(want.PublishedAt))
			}
		}
	}
}

func TestMatchedKeywordsMatchTypeScript(t *testing.T) {
	for _, c := range load(t).Keywords {
		got := domain.MatchedKeywords(domain.FeedItem{Title: c.Item.Title, Summary: c.Item.Summary}, c.Keywords)
		if !slices.Equal(got, c.Matched) {
			t.Errorf("%+v %q: %q, TypeScript %q", c.Item, c.Keywords, got, c.Matched)
		}
	}
}

func TestFeedURLProblemMatchesTypeScript(t *testing.T) {
	for _, c := range load(t).Problems {
		got := domain.FeedURLProblem(c.Input)
		want := ""
		if c.Problem != nil {
			want = *c.Problem
		}
		if unported[c.Input] {
			want = "La URL no es válida"
		}
		if got != want {
			t.Errorf("%q: %q, TypeScript %q", c.Input, got, want)
		}
	}
}

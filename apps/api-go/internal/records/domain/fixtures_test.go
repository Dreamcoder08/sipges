package domain_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The answers of the TypeScript domain on synthetic payloads, recorded by
// ../testdata/generate.mjs: spreading a payload with _id, the Registros «Todos» columns and the
// history diff must give the same bytes.
type fixtures struct {
	Slugs []string `json:"slugs"`
	Cases []struct {
		Payload   string   `json:"payload"`
		List      string   `json:"list"`
		Get       string   `json:"get"`
		Summaries []string `json:"summaries"`
	} `json:"cases"`
	Diffs []struct {
		Before  *string `json:"before"`
		After   *string `json:"after"`
		Changes string  `json:"changes"`
	} `json:"diffs"`
}

func load(t *testing.T) fixtures {
	t.Helper()
	data, err := os.ReadFile("../testdata/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixtures
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func object(t *testing.T, text *string) *domain.Object {
	t.Helper()
	if text == nil {
		return nil
	}
	o, err := domain.ParseObject([]byte(*text))
	if err != nil {
		t.Fatalf("%s: %v", *text, err)
	}
	return o
}

func TestPayloadsSpreadLikeJavaScript(t *testing.T) {
	for _, c := range load(t).Cases {
		list := object(t, &c.Payload)
		list.Set("_id", "REC-1")
		list.Set("_updated_at", "2026-01-02T03:04:05Z")
		if got := string(domain.Stringify(list)); got != c.List {
			t.Errorf("list %s\n got %s\nwant %s", c.Payload, got, c.List)
		}
		get := object(t, &c.Payload)
		get.Set("_id", "REC-1")
		if got := string(domain.Stringify(get)); got != c.Get {
			t.Errorf("get %s\n got %s\nwant %s", c.Payload, got, c.Get)
		}
	}
}

func TestSummariesMatchTypeScript(t *testing.T) {
	f := load(t)
	if len(f.Slugs) != len(domain.SummaryTypes) {
		t.Fatalf("types: %v", f.Slugs)
	}
	for i, slug := range f.Slugs {
		if domain.SummaryTypes[i].Slug != slug {
			t.Fatalf("type %d: %s, want %s", i, domain.SummaryTypes[i].Slug, slug)
		}
	}
	for _, c := range f.Cases {
		for i, want := range c.Summaries {
			got := string(domain.AppendSummary(nil, domain.Summarize(domain.SummaryTypes[i], "REC-1", object(t, &c.Payload))))
			if got != want {
				t.Errorf("%s %s\n got %s\nwant %s", f.Slugs[i], c.Payload, got, want)
			}
		}
	}
}

func TestDiffsMatchTypeScript(t *testing.T) {
	for _, d := range load(t).Diffs {
		got := string(domain.AppendChanges(nil, domain.DiffPayloads(object(t, d.Before), object(t, d.After))))
		if got != d.Changes {
			t.Errorf("%v → %v\n got %s\nwant %s", d.Before, d.After, got, d.Changes)
		}
	}
}

func TestLookupableIDs(t *testing.T) {
	long := make([]rune, 100)
	for i := range long {
		long[i] = '😀' // two UTF-16 units each: 200 in all
	}
	for id, want := range map[string]bool{
		"EV-1": true, "": true, string(long): true, string(long) + "x": false, "a\x00b": false,
	} {
		if got := domain.IsLookupableID(id); got != want {
			t.Errorf("%q: %v", id, got)
		}
	}
	if m, ok := domain.ModuleForSlug("directorio"); !ok || m != "Directorio_Territorial" {
		t.Error(m)
	}
	for _, slug := range []string{"registros", "constructor", "__proto__", "Eventos", "dashboard"} {
		if _, ok := domain.ModuleForSlug(slug); ok {
			t.Error(slug)
		}
	}
}

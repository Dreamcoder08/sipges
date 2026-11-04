package domain

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"testing"
)

// The fixture is recorded from the TypeScript domain by ../testdata/generate.mjs.

type fixtureRecord struct {
	Slug        string `json:"slug"`
	Module      string `json:"module"`
	ID          string `json:"id"`
	PayloadText string `json:"payloadText"`
	Marking     string `json:"marking"`
}

type fixtureConnection struct {
	LinkType string        `json:"linkType"`
	Label    string        `json:"label"`
	Inferred bool          `json:"inferred"`
	Other    fixtureRecord `json:"other"`
}

type fixture struct {
	Briefings []struct {
		Subject     fixtureRecord       `json:"subject"`
		Connections []fixtureConnection `json:"connections"`
		Today       string              `json:"today"`
		Expected    json.RawMessage     `json:"expected"`
	} `json:"briefings"`
	Mentions []struct {
		Self     fixtureRecord   `json:"self"`
		Other    fixtureRecord   `json:"other"`
		Title    json.RawMessage `json:"title"`
		Holder   string          `json:"holder"`
		Expected json.RawMessage `json:"expected"`
	} `json:"mentions"`
	Collate [][3]any `json:"collate"`
}

func loadFixture(t *testing.T) fixture {
	t.Helper()
	data, err := os.ReadFile("../testdata/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func summaryOf(t *testing.T, r fixtureRecord) Summary {
	t.Helper()
	objectType, ok := ObjectTypeForSlug(r.Slug)
	if !ok {
		t.Fatalf("unknown slug %q", r.Slug)
	}
	payload, err := ParsePayload([]byte(r.PayloadText))
	if err != nil {
		t.Fatal(err)
	}
	return Summarize(objectType, r.ID, r.Marking, payload)
}

// The TypeScript domain objects, as JSON.stringify writes them.

type orderedFields []Field

func (fs orderedFields) MarshalJSON() ([]byte, error) {
	out := []byte{'{'}
	for i, f := range fs {
		if i > 0 {
			out = append(out, ',')
		}
		k, _ := json.Marshal(f.Key)
		v, err := json.Marshal(Text(f.Value.(string)))
		if err != nil {
			return nil, err
		}
		out = append(append(append(out, k...), ':'), v...)
	}
	return append(out, '}'), nil
}

func subjectJSON(s Summary) map[string]any {
	var date any
	if s.Date != nil {
		date = Text(*s.Date)
	}
	return map[string]any{
		"slug": s.Slug, "id": Text(s.ID), "typeLabel": s.TypeLabel, "title": Text(s.Title),
		"date": date, "marking": s.Marking, "fields": orderedFields(s.Fields),
	}
}

func sentencesJSON(ss []Sentence) []any {
	out := []any{}
	for _, s := range ss {
		out = append(out, map[string]any{"text": Text(s.Text), "refs": s.Refs})
	}
	return out
}

func proposalJSON(p Proposal) map[string]any {
	out := map[string]any{"fingerprint": Text(p.Fingerprint), "kind": p.Kind, "title": Text(p.Title), "reason": Text(p.Reason), "link": nil, "record": nil}
	if p.Link != nil {
		out["link"] = linkJSON(*p.Link)
	}
	if p.Record != nil {
		out["record"] = map[string]any{"slug": p.Record.Slug, "payload": orderedFields(p.Record.Payload)}
	}
	return out
}

func linkJSON(l ProposedLink) map[string]any {
	return map[string]any{
		"linkType": l.LinkType,
		"source":   map[string]any{"slug": l.Source.Slug, "id": l.Source.ID},
		"target":   map[string]any{"slug": l.Target.Slug, "id": l.Target.ID},
	}
}

// wtf8 decodes a JSON string, each lone-surrogate escape into WTF-8 as the domain holds it
// (encoding/json would decode it to U+FFFD).
func wtf8(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var s string
	if err := json.Unmarshal(loneEscape.ReplaceAll(raw, []byte(`\$0`)), &s); err != nil {
		t.Fatal(err)
	}
	return regexp.MustCompile(`\\u[dD][89a-fA-F][0-9a-fA-F]{2}`).ReplaceAllStringFunc(s, func(m string) string {
		var r rune
		_, _ = fmt.Sscanf(m[2:], "%x", &r)
		return fromPoints([]rune{r})
	})
}

// loneEscape keeps lone-surrogate escapes as text, so both sides compare them instead of
// decoding them to U+FFFD.
var loneEscape = regexp.MustCompile(`\\u[dD][89a-fA-F][0-9a-fA-F]{2}`)

func sameJSON(t *testing.T, name string, got any, want json.RawMessage) {
	t.Helper()
	gotBytes, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	decode := func(b []byte) any {
		var v any
		escaped := loneEscape.ReplaceAllFunc(b, func(m []byte) []byte { return append([]byte{'\\'}, m...) })
		if err := json.Unmarshal(escaped, &v); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return v
	}
	if g, w := decode(gotBytes), decode(want); !reflect.DeepEqual(g, w) {
		t.Errorf("%s:\n got %s\nwant %s", name, gotBytes, want)
	}
}

func TestBriefingsMatchTypeScript(t *testing.T) {
	for i, c := range loadFixture(t).Briefings {
		subject := summaryOf(t, c.Subject)
		connections := make([]Connection, 0, len(c.Connections))
		for _, fc := range c.Connections {
			connections = append(connections, Connection{LinkType: fc.LinkType, Label: fc.Label, Inferred: fc.Inferred, Other: summaryOf(t, fc.Other)})
		}
		b := BuildBriefing(subject, connections, c.Today)
		sources := []any{}
		for _, s := range b.Sources {
			sources = append(sources, map[string]any{"ref": s.Ref, "slug": s.Slug, "id": Text(s.ID), "typeLabel": s.TypeLabel, "title": Text(s.Title)})
		}
		sections := []any{}
		for _, s := range b.Sections {
			sections = append(sections, map[string]any{"title": s.Title, "sentences": sentencesJSON(s.Sentences)})
		}
		followUps := []any{}
		for _, p := range FollowUpProposals(subject, connections, c.Today) {
			followUps = append(followUps, proposalJSON(p))
		}
		got := map[string]any{"subject": subjectJSON(b.Subject), "sources": sources, "sections": sections, "followUps": followUps}
		sameJSON(t, fmt.Sprintf("briefing %d", i), got, c.Expected)
	}
}

func TestMentionsMatchTypeScript(t *testing.T) {
	for i, c := range loadFixture(t).Mentions {
		payload, err := ParsePayload([]byte(c.Self.PayloadText))
		if err != nil {
			t.Fatal(err)
		}
		title := wtf8(t, c.Title)
		found, ok := FindMention(TextFields(payload), title)
		self, other := Ref{c.Self.Slug, c.Self.ID}, Ref{c.Other.Slug, c.Other.ID}
		linkType, source, target := SuggestedLink(self, other)
		suggested := ProposedLink{LinkType: linkType, Source: source, Target: target}
		got := map[string]any{"found": nil, "suggested": linkJSON(suggested), "proposal": nil}
		if ok {
			got["found"] = map[string]any{"field": found.Field, "excerpt": Text(found.Excerpt)}
			label := linkType
			if lt, known := LinkTypeByID(linkType); known {
				label = lt.Label
			}
			selfSummary, otherSummary := summaryOf(t, c.Self), summaryOf(t, c.Other)
			holderIsSelf := c.Holder == "self"
			got["proposal"] = proposalJSON(MentionProposal(selfSummary, MentionFound{
				ProposedLink: suggested, Other: otherSummary, Label: label, HolderIsSelf: holderIsSelf,
				Field: found.Field, Excerpt: found.Excerpt,
			}))
		}
		sameJSON(t, fmt.Sprintf("mention %d", i), got, c.Expected)
	}
}

func TestLocaleCompareMatchesNode(t *testing.T) {
	for _, c := range loadFixture(t).Collate {
		a, b, want := c[0].(string), c[1].(string), int(c[2].(float64))
		if got := localeCompare(a, b); got != want {
			t.Errorf("localeCompare(%q, %q) = %d, want %d", a, b, got, want)
		}
	}
}

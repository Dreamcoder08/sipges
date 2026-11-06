package application

import (
	"context"

	ontology "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	sanitised "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The read tools of mcp-tools.ts. What they build is plain data with its JSON tags; it reaches the
// client only through runRead, which seals it with the guard. Reads go through the same services as
// the web app, so row-level security and classification markings decide what an agent sees.

const (
	recordNotFound = "Registro no encontrado"
	invalidDates   = "Fechas no válidas: use AAAA, AAAA-MM o AAAA-MM-DD"
)

type readCall struct {
	MCP
	tenant  string
	session *privacy.Session
	input   *records.Object
}

// textOf reads a field ParseArguments already checked; so does objectOf.
func textOf(input *records.Object, field string) string {
	value, _ := input.Get(field)
	text, _ := value.(string)
	return text
}

func objectOf(input *records.Object, field string) *records.Object {
	value, _ := input.Get(field)
	object, _ := value.(*records.Object)
	return object
}

func (c readCall) text(field string) string { return textOf(c.input, field) }

// slugs is `input.modules ?? null`; parsed strings only.
func (c readCall) slugs() []string {
	value, _ := c.input.Get("modules")
	list, _ := value.([]any)
	slugs := make([]string, len(list))
	for i, item := range list {
		slugs[i], _ = item.(string)
	}
	return slugs
}

func (c readCall) limit() int64 {
	value, _ := c.input.Get("limit")
	limit, _ := value.(float64)
	return int64(limit)
}

// queryable says the id can match a stored row: with a lone surrogate it cannot (Node would send
// U+FFFD and the row's id would still not equal the id asked for).
func (c readCall) queryable() bool {
	id := c.text("id")
	return records.WellFormed(id) == id
}

// ToolSummary is outSummary. Exported because the guard refuses to read an unexported field, an
// embedded one included.
type ToolSummary struct {
	Module  string           `json:"module"`
	ID      sanitised.Text   `json:"id"`
	Type    string           `json:"type"`
	Title   sanitised.Text   `json:"title"`
	Date    *sanitised.Text  `json:"date"`
	Marking string           `json:"marking"`
	Fields  sanitised.Fields `json:"fields"`
}

func toSummary(s ontology.Summary, clean sanitised.SanitisedRecord) ToolSummary {
	out := ToolSummary{
		Module: s.Module, ID: sanitised.Text(s.ID), Type: s.TypeLabel, Title: sanitised.Text(s.ID),
		Date: clean.Date, Marking: s.Marking, Fields: clean.Fields,
	}
	if clean.Title != nil {
		out.Title = *clean.Title
	}
	if out.Fields == nil {
		out.Fields = sanitised.Fields{}
	}
	return out
}

func summaryKey(s ontology.Summary) string { return s.Module + "\x00" + s.ID }

func rawSummary(s ontology.Summary) sanitised.RawRecord {
	title, marking := string(s.Title), s.Marking
	fields := make([]sanitised.RawField, len(s.Fields))
	for i, f := range s.Fields {
		fields[i] = sanitised.RawField{Name: f.Name, Value: f.Value}
	}
	return sanitised.RawRecord{Module: s.Module, ID: s.ID, Title: &title, Date: s.Date, Marking: &marking, Fields: fields}
}

// cleanSummaries is sanitiseSummaries: every distinct record through the guard once.
type cleanSummaries map[string]sanitised.SanitisedRecord

func sanitiseSummaries(session *privacy.Session, list []ontology.Summary) cleanSummaries {
	seen := map[string]int{}
	distinct := []ontology.Summary{}
	for _, s := range list {
		key := summaryKey(s)
		if at, known := seen[key]; known {
			distinct[at] = s
			continue
		}
		seen[key] = len(distinct)
		distinct = append(distinct, s)
	}
	raw := make([]sanitised.RawRecord, len(distinct))
	for i, s := range distinct {
		raw[i] = rawSummary(s)
	}
	clean := session.Records(raw)
	out := make(cleanSummaries, len(distinct))
	for i, s := range distinct {
		out[summaryKey(s)] = clean[i]
	}
	return out
}

func (c cleanSummaries) of(s ontology.Summary) ToolSummary { return toSummary(s, c[summaryKey(s)]) }

func (c cleanSummaries) withheld(s ontology.Summary) bool { return c[summaryKey(s)].Withheld }

type matchJSON struct {
	Field   string          `json:"field"`
	Excerpt sanitised.Value `json:"excerpt"`
}

type hitJSON struct {
	ToolSummary
	Match    *matchJSON `json:"match"`
	Semantic bool       `json:"semantic"`
}

type searchJSON struct {
	Hits []hitJSON `json:"hits"`
}

func (c readCall) search(ctx context.Context) (any, error) {
	// What the agent typed may itself name someone; it only goes into the lexical search. A hit must
	// be explained by a field that may leave; otherwise it reveals what a dropped field holds.
	query := ontology.UnitsOf(records.WellFormed(c.text("query")))
	hits, err := c.Ontology.Search(ctx, c.tenant, query, c.slugs(), c.limit(), c.session.Allows)
	if err != nil {
		return nil, err
	}
	list := make([]ontology.Summary, len(hits))
	for i, hit := range hits {
		list[i] = hit.Summary
	}
	clean := sanitiseSummaries(c.session, list)
	// The matching excerpt is a field value too: it passes the same allowlist.
	shown := hits[:0:0]
	excerpts := []sanitised.RawRecord{}
	for _, hit := range hits {
		if clean.withheld(hit.Summary) {
			continue
		}
		shown = append(shown, hit)
		if hit.Match != nil {
			marking := hit.Marking
			excerpts = append(excerpts, sanitised.RawRecord{
				Module: hit.Module, ID: hit.ID, Marking: &marking,
				Fields: []sanitised.RawField{{Name: hit.Match.Field, Value: string(hit.Match.Excerpt)}},
			})
		}
	}
	cleanExcerpts := c.session.Records(excerpts)
	out := searchJSON{Hits: make([]hitJSON, 0, len(shown))}
	at := 0
	for _, hit := range shown {
		item := hitJSON{ToolSummary: clean.of(hit.Summary), Semantic: hit.Semantic}
		if hit.Match != nil {
			for _, field := range cleanExcerpts[at].Fields {
				if field.Name == hit.Match.Field {
					item.Match = &matchJSON{Field: field.Name, Excerpt: field.Value}
				}
			}
			at++
		}
		out.Hits = append(out.Hits, item)
	}
	return out, nil
}

type withheldJSON struct {
	Module   sanitised.Text `json:"module"`
	ID       sanitised.Text `json:"id"`
	Withheld bool           `json:"withheld"`
}

type recordJSON struct {
	Module    sanitised.Text   `json:"module"`
	ID        sanitised.Text   `json:"id"`
	UpdatedAt string           `json:"updated_at"`
	Marking   *string          `json:"marking"`
	Payload   sanitised.Fields `json:"payload"`
}

func (c readCall) record(ctx context.Context) (any, string, error) {
	slug, id := c.text("module"), c.text("id")
	module, known := records.ModuleForSlug(slug)
	if !known {
		return nil, recordNotFound, nil
	}
	found, err := c.Records.Get(ctx, c.tenant, module, records.WellFormed(id))
	if err != nil {
		return nil, "", err
	}
	if found == nil {
		return nil, recordNotFound, nil
	}
	// Without a marking the record is withheld, never guessed open.
	var marking *string
	if c.queryable() {
		linked, err := c.Ontology.Neighbours(ctx, c.tenant, slug, id)
		if err != nil {
			return nil, "", err
		}
		if linked != nil {
			marking = &linked.Record.Marking
		}
	}
	keys := found.Payload.Keys()
	fields := make([]sanitised.RawField, len(keys))
	for i, key := range keys {
		value, _ := found.Payload.Get(key)
		fields[i] = sanitised.RawField{Name: key, Value: value}
	}
	clean := c.session.Records([]sanitised.RawRecord{{Module: slug, ID: found.ID, Marking: marking, Fields: fields}})[0]
	if clean.Withheld {
		return withheldJSON{sanitised.Text(slug), sanitised.Text(found.ID), true}, "", nil
	}
	payload := clean.Fields
	if payload == nil {
		payload = sanitised.Fields{}
	}
	return recordJSON{
		Module: sanitised.Text(slug), ID: sanitised.Text(found.ID), Marking: marking, Payload: payload,
		UpdatedAt: found.UpdatedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
	}, "", nil
}

type linkJSON struct {
	LinkType  string      `json:"link_type"`
	Label     string      `json:"label"`
	Direction string      `json:"direction"`
	Inferred  bool        `json:"inferred"`
	Other     ToolSummary `json:"other"`
}

type linksJSON struct {
	Record ToolSummary `json:"record"`
	Links  []linkJSON  `json:"links"`
}

func (c readCall) links(ctx context.Context) (any, string, error) {
	slug, id := c.text("module"), c.text("id")
	if !c.queryable() {
		return nil, recordNotFound, nil
	}
	found, err := c.Ontology.Neighbours(ctx, c.tenant, slug, id)
	if err != nil {
		return nil, "", err
	}
	if found == nil {
		return nil, recordNotFound, nil
	}
	list := make([]ontology.Summary, 0, len(found.Neighbours)+1)
	list = append(list, found.Record)
	for _, n := range found.Neighbours {
		list = append(list, n.Other)
	}
	clean := sanitiseSummaries(c.session, list)
	// A restricted record's links say who it touches: only a stub leaves, as in get_record.
	if clean.withheld(found.Record) {
		return withheldJSON{sanitised.Text(slug), sanitised.Text(id), true}, "", nil
	}
	out := linksJSON{Record: clean.of(found.Record), Links: []linkJSON{}}
	for _, n := range found.Neighbours {
		if !clean.withheld(n.Other) {
			out.Links = append(out.Links, linkJSON{
				LinkType: n.Edge.LinkType, Label: n.Label, Direction: n.Direction,
				Inferred: n.Edge.Inferred, Other: clean.of(n.Other),
			})
		}
	}
	return out, "", nil
}

type timelineJSON struct {
	From      string        `json:"from"`
	To        string        `json:"to"`
	Truncated bool          `json:"truncated"`
	Entries   []ToolSummary `json:"entries"`
}

func (c readCall) timeline(ctx context.Context) (any, string, error) {
	timeline, err := c.Ontology.Timeline(ctx, c.tenant, c.text("from"), c.text("to"), c.slugs(), c.limit())
	if err != nil {
		return nil, "", err
	}
	if timeline == nil {
		return nil, invalidDates, nil
	}
	clean := sanitiseSummaries(c.session, timeline.Entries)
	out := timelineJSON{From: timeline.From, To: timeline.To, Truncated: timeline.Truncated, Entries: []ToolSummary{}}
	for _, entry := range timeline.Entries {
		if !clean.withheld(entry) {
			out.Entries = append(out.Entries, clean.of(entry))
		}
	}
	return out, "", nil
}

type subjectJSON struct {
	Module string         `json:"module"`
	ID     sanitised.Text `json:"id"`
	Title  sanitised.Text `json:"title"`
}

type sentenceJSON struct {
	Text sanitised.Text `json:"text"`
	Refs []int          `json:"refs"`
}

type sectionJSON struct {
	Title     string         `json:"title"`
	Sentences []sentenceJSON `json:"sentences"`
}

type sourceJSON struct {
	Ref    int            `json:"ref"`
	Module string         `json:"module"`
	ID     sanitised.Text `json:"id"`
	Title  sanitised.Text `json:"title"`
}

type briefingJSON struct {
	Subject   subjectJSON   `json:"subject"`
	Engine    string        `json:"engine"`
	Sections  []sectionJSON `json:"sections"`
	Narrative *sentenceJSON `json:"narrative"`
	Sources   []sourceJSON  `json:"sources"`
}

func (c readCall) briefing(ctx context.Context) (any, string, error) {
	slug, id := c.text("module"), c.text("id")
	if !c.queryable() {
		return nil, recordNotFound, nil
	}
	briefing, err := c.Analyst.Briefing(ctx, c.tenant, slug, id, c.session)
	if err != nil {
		return nil, "", err
	}
	if briefing == nil {
		return nil, recordNotFound, nil
	}
	if briefing.Withheld {
		return withheldJSON{sanitised.Text(slug), sanitised.Text(id), true}, "", nil
	}
	subject := briefing.Subject
	out := briefingJSON{
		Subject: subjectJSON{subject.Slug, sanitised.Text(subject.ID), sanitised.Text(subject.Title)},
		Engine:  briefing.Engine, Sections: make([]sectionJSON, len(briefing.Sections)),
		Sources: make([]sourceJSON, len(briefing.Sources)),
	}
	for i, section := range briefing.Sections {
		sentences := make([]sentenceJSON, len(section.Sentences))
		for j, sentence := range section.Sentences {
			sentences[j] = sentenceJSON{sanitised.Text(sentence.Text), append([]int{}, sentence.Refs...)}
		}
		out.Sections[i] = sectionJSON{section.Title, sentences}
	}
	if narrative := briefing.Narrative; narrative != nil {
		out.Narrative = &sentenceJSON{sanitised.Text(narrative.Text), append([]int{}, narrative.Refs...)}
	}
	for i, source := range briefing.Sources {
		out.Sources[i] = sourceJSON{source.Ref, source.Slug, sanitised.Text(source.ID), sanitised.Text(source.Title)}
	}
	return out, "", nil
}

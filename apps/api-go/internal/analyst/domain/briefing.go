// Package domain holds the analyst's pure rules, ported from apps/api/src/contexts/analyst/domain
// (briefing.ts, proposals.ts), and the read-only part of the ontology catalog they need. Output is
// byte-compatible with the TypeScript domain: testdata/generate.mjs records it on synthetic inputs.
//
//nolint:misspell // Spanish record fields, modules and messages, verbatim from the TypeScript API.
package domain

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode"
)

// Bounds of briefing.ts.
const (
	MaxListedConnections = 8
	MaxTimelineEntries   = 6
	MaxSignals           = 8
	maxQuote             = 160
)

// ignoreCase is a JavaScript /…/i pattern without the u flag over alternatives of lower-case
// words: each letter matches itself and its upper case only (Go's (?i) would also fold ſ and K).
func ignoreCase(words ...string) *regexp.Regexp {
	alternatives := make([]string, len(words))
	for i, word := range words {
		var b strings.Builder
		for _, r := range word {
			if up := unicode.ToUpper(r); up != r {
				fmt.Fprintf(&b, "[%c%c]", r, up)
				continue
			}
			b.WriteString(regexp.QuoteMeta(string(r)))
		}
		alternatives[i] = b.String()
	}
	return regexp.MustCompile(strings.Join(alternatives, "|"))
}

var (
	closed  = ignoreCase("cerrad", "cumplid", "resuelt", "atendid", "finaliz", "archiv", "descartad", "complet", "superad")
	severe  = ignoreCase("alt", "crít", "crit", "urgent", "grave", "roj")
	opposed = ignoreCase("contra", "oposi", "opuest", "rechaz", "hostil")
	isoDate = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}`)
)

// Connection is a visible link from the subject to another record.
type Connection struct {
	LinkType string
	// Label reads from the subject towards Other, e.g. "participa en".
	Label    string
	Inferred bool
	Other    Summary
}

// Source is a cited record.
type Source struct {
	Ref       int
	Slug      string
	ID        string
	TypeLabel string
	Title     string
}

// Sentence is one cited statement.
type Sentence struct {
	Text string
	Refs []int
}

// Section is a titled group of sentences.
type Section struct {
	Title     string
	Sentences []Sentence
}

// Briefing is the extractive briefing of one record.
type Briefing struct {
	Subject  Summary
	Sources  []Source
	Sections []Section
}

// cut is the quote and short of the TypeScript domain: whitespace runs as one space, trimmed,
// cut to limit code points with an ellipsis.
func cut(value string, limit int) string {
	points := codePoints(trimJS(collapseSpaces(value)))
	if len(points) > limit {
		return fromPoints(points[:limit-1]) + "…"
	}
	return fromPoints(points)
}

func quote(value string) string { return cut(value, maxQuote) }

func named(s Summary) string { return s.TypeLabel + " «" + quote(s.Title) + "»" }

func plural(count int, one, many string) string {
	if count == 1 {
		return fmt.Sprintf("%d %s", count, one)
	}
	return fmt.Sprintf("%d %s", count, many)
}

// IsOpen is isOpen: the record's Estado does not read as closed.
func IsOpen(s Summary) bool { return !closed.MatchString(s.Field("Estado")) }

func signalsOf(s Summary, today string) []string {
	var found []string
	if s.Slug == "alertas" && IsOpen(s) && severe.MatchString(s.Field("Nivel_Preliminar")) {
		found = append(found, fmt.Sprintf("%s sigue abierta con nivel %s.", named(s), quote(s.Field("Nivel_Preliminar"))))
	}
	if s.Slug == "compromisos" && IsOpen(s) {
		due := s.Field("Plazo")
		if isoDate.MatchString(due) && due[:10] < today {
			found = append(found, fmt.Sprintf("%s venció el %s sin cerrarse.", named(s), due[:10]))
		}
	}
	if s.Slug == "demandas" && IsOpen(s) && severe.MatchString(s.Field("Prioridad")) {
		found = append(found, fmt.Sprintf("%s tiene prioridad %s y sigue abierta.", named(s), quote(s.Field("Prioridad"))))
	}
	if s.Slug == "actores" && opposed.MatchString(s.Field("Posicion_Proyecto")) {
		found = append(found, fmt.Sprintf("%s mantiene una posición %s.", named(s), quote(s.Field("Posicion_Proyecto"))))
	}
	return found
}

func dateOf(s Summary) string {
	if s.Date == nil {
		return ""
	}
	return *s.Date
}

// BuildBriefing is buildBriefing: the cited briefing of subject from its visible connections.
// today (ISO date) flags overdue commitments; ordering is deterministic.
func BuildBriefing(subject Summary, connections []Connection, today string) Briefing {
	sources := []Source{}
	refs := map[Ref]int{}
	cite := func(record Summary) int {
		if known, ok := refs[record.Ref()]; ok {
			return known
		}
		ref := len(sources) + 1
		refs[record.Ref()] = ref
		sources = append(sources, Source{Ref: ref, Slug: record.Slug, ID: record.ID, TypeLabel: record.TypeLabel, Title: record.Title})
		return ref
	}
	self := cite(subject)

	overviewHead := named(subject)
	if subject.Date != nil {
		overviewHead += ", registrado con fecha " + *subject.Date
	}
	overview := []Sentence{{Text: overviewHead + ".", Refs: []int{self}}}
	for _, f := range subject.Fields {
		value, _ := f.Value.(string)
		overview = append(overview, Sentence{Text: strings.ReplaceAll(f.Key, "_", " ") + ": " + quote(value) + ".", Refs: []int{self}})
	}

	ordered := append([]Connection(nil), connections...)
	sort.SliceStable(ordered, func(i, j int) bool {
		a, b := ordered[i], ordered[j]
		if a.Inferred != b.Inferred {
			return !a.Inferred
		}
		if c := localeCompare(dateOf(b.Other), dateOf(a.Other)); c != 0 {
			return c < 0
		}
		if c := localeCompare(a.Other.TypeLabel, b.Other.TypeLabel); c != 0 {
			return c < 0
		}
		return localeCompare(a.Other.ID, b.Other.ID) < 0
	})

	var network []Sentence
	if len(connections) > 0 {
		type group struct {
			label           string
			total, inferred int
		}
		var groups []*group
		byLabel := map[string]*group{}
		for _, c := range ordered {
			g, ok := byLabel[c.Label]
			if !ok {
				g = &group{label: c.Label}
				byLabel[c.Label] = g
				groups = append(groups, g)
			}
			g.total++
			if c.Inferred {
				g.inferred++
			}
		}
		unique := map[Ref]bool{}
		for _, c := range connections {
			unique[c.Other.Ref()] = true
		}
		network = append(network, Sentence{
			Text: fmt.Sprintf("Tiene %s con %s.", plural(len(connections), "vínculo", "vínculos"), plural(len(unique), "registro", "registros")),
			Refs: []int{self},
		})
		sort.SliceStable(groups, func(i, j int) bool {
			if groups[i].total != groups[j].total {
				return groups[i].total > groups[j].total
			}
			return localeCompare(groups[i].label, groups[j].label) < 0
		})
		for _, g := range groups {
			text := g.label + ": " + plural(g.total, "registro", "registros")
			if g.inferred > 0 {
				suffix := "s"
				if g.inferred == 1 {
					suffix = ""
				}
				text += fmt.Sprintf(" (%d inferido%s de los datos)", g.inferred, suffix)
			}
			network = append(network, Sentence{Text: text + ".", Refs: []int{}})
		}
		for _, c := range ordered[:min(len(ordered), MaxListedConnections)] {
			text := c.Label + " " + named(c.Other)
			if c.Other.Date != nil {
				text += " (" + *c.Other.Date + ")"
			}
			if c.Inferred {
				text += ", vínculo inferido"
			}
			network = append(network, Sentence{Text: text + ".", Refs: []int{cite(c.Other)}})
		}
	} else {
		network = []Sentence{{
			Text: "No tiene vínculos registrados ni inferidos. Vincularlo a actores, fuentes o eventos completaría su contexto.",
			Refs: []int{self},
		}}
	}

	all := []Summary{subject}
	for _, c := range ordered {
		all = append(all, c.Other)
	}
	firstSeen := map[Ref]bool{}
	var dated []Summary
	for _, record := range all {
		if firstSeen[record.Ref()] {
			continue
		}
		firstSeen[record.Ref()] = true
		if record.Date != nil {
			dated = append(dated, record)
		}
	}
	sort.SliceStable(dated, func(i, j int) bool {
		if c := localeCompare(*dated[j].Date, *dated[i].Date); c != 0 {
			return c < 0
		}
		return localeCompare(dated[i].ID, dated[j].ID) < 0
	})
	var timeline []Sentence
	for _, record := range dated[:min(len(dated), MaxTimelineEntries)] {
		timeline = append(timeline, Sentence{Text: *record.Date + ": " + named(record) + ".", Refs: []int{cite(record)}})
	}

	var signals []Sentence
	for _, text := range signalsOf(subject, today) {
		signals = append(signals, Sentence{Text: text, Refs: []int{self}})
	}
	for _, c := range ordered {
		for _, text := range signalsOf(c.Other, today) {
			signals = append(signals, Sentence{Text: text, Refs: []int{cite(c.Other)}})
		}
	}
	for _, c := range ordered {
		if c.LinkType == "en_conflicto_con" {
			signals = append(signals, Sentence{Text: "Hay un conflicto registrado con " + named(c.Other) + ".", Refs: []int{self, cite(c.Other)}})
		}
	}
	signals = signals[:min(len(signals), MaxSignals)]
	restricted := 0
	for _, c := range connections {
		if c.Other.Marking == "restringido" {
			restricted++
		}
	}
	if restricted > 0 {
		signals = append(signals, Sentence{Text: plural(restricted, "vínculo apunta", "vínculos apuntan") + " a información restringida.", Refs: []int{}})
	}

	sections := []Section{{Title: "Resumen", Sentences: overview}, {Title: "Red de vínculos", Sentences: network}}
	if len(timeline) > 0 {
		sections = append(sections, Section{Title: "Cronología", Sentences: timeline})
	}
	if len(signals) == 0 {
		signals = []Sentence{{Text: "No se detectan alertas abiertas, compromisos vencidos ni conflictos registrados.", Refs: []int{}}}
	}
	sections = append(sections, Section{Title: "Señales de atención", Sentences: signals})
	return Briefing{Subject: subject, Sources: sources, Sections: sections}
}

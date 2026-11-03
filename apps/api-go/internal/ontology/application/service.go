// Package application is the read side of
// apps/api/src/contexts/ontology/application/ontology-service.ts: a record's links, its graph,
// the lexical search and the timeline. Links, markings and the neighbourhood POST stay in
// TypeScript; so does the semantic half of search (embeddings through the egress guard).
package application

import (
	"context"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
)

// Bounds of ontology-service.ts.
const (
	MaxGraphDepth      = 2
	MaxGraphNodes      = 150
	MaxSearchResults   = 50
	MaxTimelineResults = 500
	maxID              = 200
)

// NodeRef is a record by stored module name and id.
type NodeRef struct{ Module, ID string }

// NodeRow is a visible record.
type NodeRow struct {
	NodeRef
	Payload domain.Payload
	Marking string
}

// DatedRow is a record with the day its date field holds.
type DatedRow struct {
	NodeRow
	Day string
}

// StoredLink is an explicit link.
type StoredLink struct {
	ID               int64
	LinkType         string
	Source, Target   NodeRef
	Note             string
	CreatedBy        string
	CreatedAt        time.Time
	EvidenceSourceID *string
}

// ResolvedRule is an inference rule with stored module names.
type ResolvedRule struct {
	Index            int
	HolderModule     string
	Field            string
	TargetModule     string
	Match            string
	TargetTitleField string
}

// InferredMatch is a holder record whose field resolved to a target record under rule Index.
type InferredMatch struct {
	Index          int
	Holder, Target NodeRef
}

// DateField names a module's date field.
type DateField struct{ Module, Field string }

// Store reads one tenant's records and links; every call runs in the request's tenant
// transaction (docs/adr/0003).
type Store interface {
	Nodes(ctx context.Context, refs []NodeRef) ([]NodeRow, error)
	Search(ctx context.Context, query *string, exactID string, modules []string, limit int) ([]NodeRow, error)
	Dated(ctx context.Context, fields []DateField, from, to string, limit int) ([]DatedRow, error)
	Links(ctx context.Context, refs []NodeRef) ([]StoredLink, error)
	Inferred(ctx context.Context, refs []NodeRef, rules []ResolvedRule) ([]InferredMatch, error)
}

// Rules is RULES of ontology-service.ts: every inference rule with both ends in the catalog.
var Rules = func() []ResolvedRule {
	rules := []ResolvedRule{}
	for index, rule := range domain.InferenceRules {
		holder, ok := domain.ObjectTypeForSlug(rule.Holder)
		target, ok2 := domain.ObjectTypeForSlug(rule.Target)
		if ok && ok2 {
			rules = append(rules, ResolvedRule{index, holder.Module, rule.Field, target.Module, rule.Match, target.TitleField})
		}
	}
	return rules
}()

// End is one end of an edge, by slug.
type End struct{ Slug, ID string }

// Edge is Edge of ontology-service.ts. EvidenceStatus is empty for inferred edges.
type Edge struct {
	ID             *int64
	LinkType       string
	Source, Target End
	Inferred       bool
	Via            *string
	Note           string
	CreatedBy      *string
	CreatedAt      *time.Time
	Evidence       *domain.Summary
	EvidenceStatus string
}

// Neighbour is a record linked to the one asked for.
type Neighbour struct {
	Edge      Edge
	Direction string
	Label     string
	Other     domain.Summary
}

// Links is the record and its neighbours.
type Links struct {
	Record     domain.Summary
	Neighbours []Neighbour
}

// Graph is a record's bounded neighbourhood.
type Graph struct {
	Root      End
	Nodes     []domain.Summary
	Edges     []Edge
	Truncated bool
}

// Hit is a search hit.
type Hit struct {
	domain.Summary
	Match *domain.Match
}

// Timeline is the dated records between two days.
type Timeline struct {
	From, To  string
	Entries   []domain.Summary
	Truncated bool
}

// Service answers the ontology read routes over one tenant's Store.
type Service struct{ Store Store }

func key(r NodeRef) string { return r.Module + "\x00" + r.ID }

func isUsableID(id domain.Units) bool {
	if len(id) == 0 || len(id) > maxID {
		return false
	}
	for _, c := range id {
		if c == 0 {
			return false
		}
	}
	return true
}

func refFor(slug, id string) (NodeRef, bool) {
	t, ok := domain.ObjectTypeForSlug(slug)
	if !ok || !isUsableID(domain.UnitsOf(id)) {
		return NodeRef{}, false
	}
	return NodeRef{t.Module, id}, true
}

// summaries keeps the store's row order, keyed by slug and id.
type summaries struct {
	list  []domain.Summary
	index map[string]int
}

func (s summaries) get(slug, id string) (domain.Summary, bool) {
	i, ok := s.index[slug+"\x00"+id]
	if !ok {
		return domain.Summary{}, false
	}
	return s.list[i], true
}

func (s Service) summaries(ctx context.Context, refs []NodeRef, extra []string) (summaries, error) {
	out := summaries{list: []domain.Summary{}, index: map[string]int{}}
	if len(refs) == 0 {
		return out, nil
	}
	rows, err := s.Store.Nodes(ctx, refs)
	if err != nil {
		return out, err
	}
	for _, row := range rows {
		t, ok := domain.ObjectTypeForModule(row.Module)
		if !ok {
			continue
		}
		k := t.Slug + "\x00" + row.ID
		summary := domain.Summarize(t, row.ID, row.Payload, row.Marking, extra)
		if i, seen := out.index[k]; seen {
			out.list[i] = summary
			continue
		}
		out.index[k] = len(out.list)
		out.list = append(out.list, summary)
	}
	return out, nil
}

// edgesTouching is edgesTouching: explicit and inferred edges touching refs, explicit first,
// without duplicates.
func (s Service) edgesTouching(ctx context.Context, refs []NodeRef) ([]Edge, error) {
	links, err := s.Store.Links(ctx, refs)
	if err != nil {
		return nil, err
	}
	matches := []InferredMatch{}
	if len(Rules) > 0 && len(refs) > 0 {
		if matches, err = s.Store.Inferred(ctx, refs, Rules); err != nil {
			return nil, err
		}
	}
	evidenceType, _ := domain.ObjectTypeForSlug("fuentes")
	evidenceRefs := []NodeRef{}
	for _, link := range links {
		if link.EvidenceSourceID != nil && *link.EvidenceSourceID != "" {
			evidenceRefs = append(evidenceRefs, NodeRef{evidenceType.Module, *link.EvidenceSourceID})
		}
	}
	evidence := map[string]domain.Summary{}
	if len(evidenceRefs) > 0 {
		rows, err := s.Store.Nodes(ctx, evidenceRefs)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			evidence[row.ID] = domain.Summarize(evidenceType, row.ID, row.Payload, row.Marking, nil)
		}
	}
	edges := []Edge{}
	seen := map[string]bool{}
	add := func(edge Edge, source, target NodeRef) {
		id := edge.LinkType + "\x01" + key(source) + "\x01" + key(target)
		if seen[id] {
			return
		}
		seen[id] = true
		edges = append(edges, edge)
	}
	for _, link := range links {
		source, ok := domain.ObjectTypeForModule(link.Source.Module)
		target, ok2 := domain.ObjectTypeForModule(link.Target.Module)
		if !ok || !ok2 {
			continue
		}
		id, createdBy, createdAt := link.ID, link.CreatedBy, link.CreatedAt
		edge := Edge{
			ID: &id, LinkType: link.LinkType,
			Source: End{source.Slug, link.Source.ID}, Target: End{target.Slug, link.Target.ID},
			Note: link.Note, CreatedBy: &createdBy, CreatedAt: &createdAt, EvidenceStatus: "undocumented",
		}
		if link.EvidenceSourceID != nil && *link.EvidenceSourceID != "" {
			edge.EvidenceStatus = "unavailable"
			if summary, ok := evidence[*link.EvidenceSourceID]; ok {
				edge.Evidence, edge.EvidenceStatus = &summary, "available"
			}
		}
		add(edge, link.Source, link.Target)
	}
	for _, match := range matches {
		if match.Index < 0 || match.Index >= len(domain.InferenceRules) {
			continue
		}
		rule := domain.InferenceRules[match.Index]
		from, to := match.Target, match.Holder
		if rule.HolderIsSource {
			from, to = match.Holder, match.Target
		}
		source, ok := domain.ObjectTypeForModule(from.Module)
		target, ok2 := domain.ObjectTypeForModule(to.Module)
		if !ok || !ok2 {
			continue
		}
		via := rule.Field
		add(Edge{
			LinkType: rule.LinkType, Source: End{source.Slug, from.ID}, Target: End{target.Slug, to.ID},
			Inferred: true, Via: &via,
		}, from, to)
	}
	return edges, nil
}

// Neighbours is neighbours: the record and every record linked to it; nil when it does not
// exist or is not visible.
func (s Service) Neighbours(ctx context.Context, slug, id string) (*Links, error) {
	ref, ok := refFor(slug, id)
	if !ok {
		return nil, nil
	}
	own, err := s.summaries(ctx, []NodeRef{ref}, nil)
	if err != nil {
		return nil, err
	}
	self, ok := own.get(slug, id)
	if !ok {
		return nil, nil
	}
	edges, err := s.edgesTouching(ctx, []NodeRef{ref})
	if err != nil {
		return nil, err
	}
	others := make([]End, len(edges))
	refs := []NodeRef{}
	for i, edge := range edges {
		others[i] = edge.Source
		if edge.Source.Slug == slug && edge.Source.ID == id {
			others[i] = edge.Target
		}
		if r, ok := refFor(others[i].Slug, others[i].ID); ok {
			refs = append(refs, r)
		}
	}
	found, err := s.summaries(ctx, refs, nil)
	if err != nil {
		return nil, err
	}
	out := &Links{Record: self, Neighbours: []Neighbour{}}
	for i, edge := range edges {
		summary, ok := found.get(others[i].Slug, others[i].ID)
		linkType, ok2 := domain.LinkTypeByID(edge.LinkType)
		if !ok || !ok2 {
			continue
		}
		n := Neighbour{Edge: edge, Direction: "in", Label: linkType.InverseLabel, Other: summary}
		if edge.Source.Slug == slug && edge.Source.ID == id {
			n.Direction, n.Label = "out", linkType.Label
		}
		out.Neighbours = append(out.Neighbours, n)
	}
	return out, nil
}

// explore is explore: breadth first from roots, one entry of hops per hop (nil follows every
// link type), bounded by maxNodes.
func (s Service) explore(ctx context.Context, roots []NodeRef, hops [][]string, maxNodes int, extra []string) ([]domain.Summary, []Edge, bool, error) {
	visited := map[string]bool{}
	order := []NodeRef{}
	for _, root := range roots {
		if !visited[key(root)] {
			visited[key(root)] = true
			order = append(order, root)
		}
	}
	edgeIndex := map[string]int{}
	edges := []Edge{}
	frontier := append([]NodeRef{}, roots...)
	truncated := false
	for _, follow := range hops[:min(len(hops), MaxGraphDepth)] {
		if len(frontier) == 0 {
			break
		}
		next := []NodeRef{}
		touching, err := s.edgesTouching(ctx, frontier)
		if err != nil {
			return nil, nil, false, err
		}
		for _, edge := range touching {
			if follow != nil && !contains(follow, edge.LinkType) {
				continue
			}
			source, ok := refFor(edge.Source.Slug, edge.Source.ID)
			target, ok2 := refFor(edge.Target.Slug, edge.Target.ID)
			if !ok || !ok2 {
				continue
			}
			missing := []NodeRef{}
			for _, end := range []NodeRef{source, target} {
				if !visited[key(end)] {
					missing = append(missing, end)
				}
			}
			if len(order)+len(missing) > maxNodes {
				truncated = true
				continue
			}
			for _, end := range missing {
				visited[key(end)] = true
				order = append(order, end)
				next = append(next, end)
			}
			k := edge.LinkType + "\x01" + edge.Source.Slug + "\x00" + edge.Source.ID + "\x01" + edge.Target.Slug + "\x00" + edge.Target.ID
			if i, ok := edgeIndex[k]; ok {
				edges[i] = edge // Map.set keeps the first position
				continue
			}
			edgeIndex[k] = len(edges)
			edges = append(edges, edge)
		}
		frontier = next
	}
	nodes, err := s.summaries(ctx, order, extra)
	if err != nil {
		return nil, nil, false, err
	}
	present := []Edge{}
	for _, edge := range edges {
		_, ok := nodes.get(edge.Source.Slug, edge.Source.ID)
		_, ok2 := nodes.get(edge.Target.Slug, edge.Target.ID)
		if ok && ok2 {
			present = append(present, edge)
		}
	}
	return nodes.list, present, truncated, nil
}

func contains(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}

// truncOr1 is Math.trunc(n) || 1 for an integer.
func truncOr1(n int64) int64 {
	if n == 0 {
		return 1
	}
	return n
}

func clamp(n, lo, hi int64) int64 { return max(lo, min(hi, n)) }

// Graph is graph: the record's neighbourhood to depth 1 or 2; nil when the record does not
// exist or is not visible.
func (s Service) Graph(ctx context.Context, slug, id string, depth int64) (*Graph, error) {
	root, ok := refFor(slug, id)
	if !ok {
		return nil, nil
	}
	hops := make([][]string, clamp(truncOr1(depth), 1, MaxGraphDepth))
	nodes, edges, truncated, err := s.explore(ctx, []NodeRef{root}, hops, MaxGraphNodes, nil)
	if err != nil {
		return nil, err
	}
	for _, n := range nodes {
		if n.Module == slug && n.ID == id {
			return &Graph{Root: End{slug, id}, Nodes: nodes, Edges: edges, Truncated: truncated}, nil
		}
	}
	return nil, nil
}

func typesFor(slugs []string, dated bool) []domain.ObjectType {
	if len(slugs) == 0 {
		slugs = make([]string, 0, len(domain.ObjectTypes))
		for _, t := range domain.ObjectTypes {
			slugs = append(slugs, t.Slug)
		}
	}
	types := []domain.ObjectType{}
	for _, slug := range slugs {
		if t, ok := domain.ObjectTypeForSlug(slug); ok && (!dated || t.DateField != "") {
			types = append(types, t)
		}
	}
	return types
}

// Search is the lexical half of search (docs/adr/0011 §5): records of slugs (every type when
// empty) whose id equals the query or that hold every term as a prefix, best first.
func (s Service) Search(ctx context.Context, raw domain.Units, slugs []string, limit int64) ([]Hit, error) {
	terms := domain.SearchTerms(raw.String())
	query := domain.ToPrefixQuery(terms)
	types := typesFor(slugs, false)
	exactID := raw.Trim()
	if len(types) == 0 {
		return []Hit{}, nil
	}
	bounded := clamp(truncOr1(limit), 1, MaxSearchResults)
	rows := []NodeRow{}
	if query != nil || isUsableID(exactID) {
		modules := make([]string, len(types))
		for i, t := range types {
			modules[i] = t.Module
		}
		var err error
		if rows, err = s.Store.Search(ctx, query, exactID.String(), modules, int(bounded)); err != nil {
			return nil, err
		}
	}
	hits := []Hit{}
	for _, row := range rows[:min(len(rows), int(bounded))] {
		t, ok := domain.ObjectTypeForModule(row.Module)
		if !ok {
			continue
		}
		preferred := append([]string{t.TitleField}, t.SummaryFields...)
		hits = append(hits, Hit{
			Summary: domain.Summarize(t, row.ID, row.Payload, row.Marking, nil),
			Match:   domain.MatchExcerpt(row.Payload, terms, preferred),
		})
	}
	return hits, nil
}

// Timeline is timeline (docs/adr/0011 §7); nil when a bound is not a date.
func (s Service) Timeline(ctx context.Context, fromRaw, toRaw string, slugs []string, limit int64) (*Timeline, error) {
	from, ok := domain.DayBound(fromRaw, false)
	to, ok2 := domain.DayBound(toRaw, true)
	if !ok || !ok2 {
		return nil, nil
	}
	out := &Timeline{From: from, To: to, Entries: []domain.Summary{}}
	types := typesFor(slugs, true)
	if len(types) == 0 || from > to {
		return out, nil
	}
	bounded := int(clamp(truncOr1(limit), 1, MaxTimelineResults))
	fields := make([]DateField, len(types))
	for i, t := range types {
		fields[i] = DateField{t.Module, t.DateField}
	}
	rows, err := s.Store.Dated(ctx, fields, from, to, bounded+1)
	if err != nil {
		return nil, err
	}
	for _, row := range rows[:min(len(rows), bounded)] {
		t, ok := domain.ObjectTypeForModule(row.Module)
		if !ok {
			continue
		}
		summary := domain.Summarize(t, row.ID, row.Payload, row.Marking, nil)
		day := row.Day
		summary.Date = &day
		out.Entries = append(out.Entries, summary)
	}
	out.Truncated = len(rows) > bounded
	return out, nil
}

// Package application is the deterministic read side of
// apps/api/src/contexts/analyst/application/analyst-service.ts: the extractive briefing of one
// record and its open proposals. The record's neighbourhood and text mentions are read as
// apps/api/src/contexts/ontology/application/ontology-service.ts (neighbours, mentions) reads
// them. The narrator behind the egress guard is in assisted.go and proposal decisions in decide.go.
//
//nolint:misspell // Spanish record fields, modules and messages, verbatim from the TypeScript API.
package application

import (
	"context"
	"strings"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	kernel "github.com/Dreamcoder08/sipges/apps/api-go/internal/management/domain"
)

// Bounds of ontology-service.ts.
const (
	MaxMentionCandidates = 2000
	MaxMentions          = 12
	maxID                = 200
)

// NodeRef is a record by stored module name and id.
type NodeRef struct {
	Module string
	ID     string
}

// NodeRow is a stored record.
type NodeRow struct {
	NodeRef
	Payload domain.Payload
	Marking string
}

// StoredLink is an explicit link.
type StoredLink struct {
	LinkType string
	Source   NodeRef
	Target   NodeRef
}

// InferredMatch is a holder whose field resolved to a target under InferenceRules[Rule].
type InferredMatch struct {
	Rule   int
	Holder NodeRef
	Target NodeRef
}

// Reader reads one tenant's records; every call runs in the request's tenant transaction.
type Reader interface {
	Nodes(ctx context.Context, refs []NodeRef) ([]NodeRow, error)
	// Recent is the most recently updated records of modules, newest first.
	Recent(ctx context.Context, modules []string, limit int) ([]NodeRow, error)
	// Links is the explicit links with either end in refs, by id.
	Links(ctx context.Context, refs []NodeRef) ([]StoredLink, error)
	// Inferred is the inferred matches with either end in refs.
	Inferred(ctx context.Context, refs []NodeRef) ([]InferredMatch, error)
	// Decided is the fingerprints among fingerprints someone already decided.
	Decided(ctx context.Context, fingerprints []string) (map[string]bool, error)
}

// Today is limaToday(now): the calendar day in Peru, YYYY-MM-DD.
func Today(now time.Time) string { return kernel.LimaToday(now) }

// refFor is refFor: the stored ref of a slug and a usable id.
func refFor(slug, id string) (NodeRef, bool) {
	t, ok := domain.ObjectTypeForSlug(slug)
	if !ok || id == "" || domain.Len16(id) > maxID || strings.ContainsRune(id, 0) {
		return NodeRef{}, false
	}
	return NodeRef{t.Module, id}, true
}

type edge struct {
	linkType string
	source   domain.Ref
	target   domain.Ref
	inferred bool
}

// edgesTouching is edgesTouching: explicit and inferred edges touching refs, explicit first,
// without duplicates.
func edgesTouching(ctx context.Context, r Reader, refs []NodeRef) ([]edge, error) {
	links, err := r.Links(ctx, refs)
	if err != nil {
		return nil, err
	}
	matches, err := r.Inferred(ctx, refs)
	if err != nil {
		return nil, err
	}
	var edges []edge
	seen := map[[5]string]bool{}
	add := func(e edge, source, target NodeRef) {
		key := [5]string{e.linkType, source.Module, source.ID, target.Module, target.ID}
		if seen[key] {
			return
		}
		seen[key] = true
		edges = append(edges, e)
	}
	for _, l := range links {
		source, sok := domain.ObjectTypeForModule(l.Source.Module)
		target, tok := domain.ObjectTypeForModule(l.Target.Module)
		if !sok || !tok {
			continue
		}
		add(edge{l.LinkType, domain.Ref{Slug: source.Slug, ID: l.Source.ID}, domain.Ref{Slug: target.Slug, ID: l.Target.ID}, false}, l.Source, l.Target)
	}
	for _, m := range matches {
		if m.Rule < 0 || m.Rule >= len(domain.InferenceRules) {
			continue
		}
		rule := domain.InferenceRules[m.Rule]
		from, to := m.Target, m.Holder
		if rule.HolderIsSource {
			from, to = m.Holder, m.Target
		}
		source, sok := domain.ObjectTypeForModule(from.Module)
		target, tok := domain.ObjectTypeForModule(to.Module)
		if !sok || !tok {
			continue
		}
		add(edge{rule.LinkType, domain.Ref{Slug: source.Slug, ID: from.ID}, domain.Ref{Slug: target.Slug, ID: to.ID}, true}, from, to)
	}
	return edges, nil
}

// summaries is summaries: the visible records of refs, by slug and id.
func summaries(ctx context.Context, r Reader, refs []NodeRef) (map[domain.Ref]domain.Summary, error) {
	out := map[domain.Ref]domain.Summary{}
	if len(refs) == 0 {
		return out, nil
	}
	rows, err := r.Nodes(ctx, refs)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		if t, ok := domain.ObjectTypeForModule(row.Module); ok {
			out[domain.Ref{Slug: t.Slug, ID: row.ID}] = domain.Summarize(t, row.ID, row.Marking, row.Payload)
		}
	}
	return out, nil
}

// Neighbourhood is the record and its visible connections.
type Neighbourhood struct {
	Subject     domain.Summary
	Connections []domain.Connection
}

// Neighbours is neighbours of ontology-service.ts, as the analyst's BriefingSource maps it; ok
// is false when the record does not exist or is not visible.
func Neighbours(ctx context.Context, r Reader, slug, id string) (Neighbourhood, bool, error) {
	ref, ok := refFor(slug, id)
	if !ok {
		return Neighbourhood{}, false, nil
	}
	selfRows, err := summaries(ctx, r, []NodeRef{ref})
	if err != nil {
		return Neighbourhood{}, false, err
	}
	self, ok := selfRows[domain.Ref{Slug: slug, ID: id}]
	if !ok {
		return Neighbourhood{}, false, nil
	}
	edges, err := edgesTouching(ctx, r, []NodeRef{ref})
	if err != nil {
		return Neighbourhood{}, false, err
	}
	selfRef := domain.Ref{Slug: slug, ID: id}
	others := make([]domain.Ref, len(edges))
	var otherRefs []NodeRef
	for i, e := range edges {
		others[i] = e.source
		if e.source == selfRef {
			others[i] = e.target
		}
		if nodeRef, ok := refFor(others[i].Slug, others[i].ID); ok {
			otherRefs = append(otherRefs, nodeRef)
		}
	}
	found, err := summaries(ctx, r, otherRefs)
	if err != nil {
		return Neighbourhood{}, false, err
	}
	connections := []domain.Connection{}
	for i, e := range edges {
		summary, ok := found[others[i]]
		linkType, known := domain.LinkTypeByID(e.linkType)
		if !ok || !known {
			continue
		}
		label := linkType.InverseLabel
		if e.source == selfRef {
			label = linkType.Label
		}
		connections = append(connections, domain.Connection{LinkType: e.linkType, Label: label, Inferred: e.inferred, Other: summary})
	}
	return Neighbourhood{Subject: self, Connections: connections}, true, nil
}

// Mentions is mentions of ontology-service.ts with the analyst's mapping: unlinked records whose
// title appears in this record's text, or that name this record in theirs.
func Mentions(ctx context.Context, r Reader, slug, id string) ([]domain.MentionFound, error) {
	ref, ok := refFor(slug, id)
	objectType, typed := domain.ObjectTypeForSlug(slug)
	if !ok || !typed {
		return nil, nil
	}
	rows, err := r.Nodes(ctx, []NodeRef{ref})
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	row := rows[0]
	self := domain.Ref{Slug: slug, ID: id}
	var modules []string
	for _, t := range domain.ObjectTypes {
		if linkType, _, _ := domain.SuggestedLink(self, domain.Ref{Slug: t.Slug}); linkType != "relacionado_con" {
			modules = append(modules, t.Module)
		}
	}
	if len(modules) == 0 {
		return []domain.MentionFound{}, nil
	}
	edges, err := edgesTouching(ctx, r, []NodeRef{ref})
	if err != nil {
		return nil, err
	}
	connected := map[domain.Ref]bool{}
	for _, e := range edges {
		if e.source == self {
			connected[e.target] = true
		} else {
			connected[e.source] = true
		}
	}
	selfText := domain.TextFields(row.Payload)
	selfTitle := domain.TitleOf(objectType, id, row.Payload)
	candidates, err := r.Recent(ctx, modules, MaxMentionCandidates)
	if err != nil {
		return nil, err
	}
	found := []domain.MentionFound{}
	for _, candidate := range candidates {
		otherType, ok := domain.ObjectTypeForModule(candidate.Module)
		if !ok || (otherType.Slug == slug && candidate.ID == id) {
			continue
		}
		otherRef := domain.Ref{Slug: otherType.Slug, ID: candidate.ID}
		if connected[otherRef] {
			continue
		}
		other := domain.Summarize(otherType, candidate.ID, candidate.Marking, candidate.Payload)
		var (
			mention domain.Mention
			inSelf  bool
			inOther bool
		)
		if other.Title != candidate.ID {
			mention, inSelf = domain.FindMention(selfText, other.Title)
		}
		if !inSelf && selfTitle != id {
			mention, inOther = domain.FindMention(domain.TextFields(candidate.Payload), selfTitle)
		}
		if !inSelf && !inOther {
			continue
		}
		linkType, source, target := domain.SuggestedLink(self, otherRef)
		label := linkType
		if t, ok := domain.LinkTypeByID(linkType); ok {
			label = t.Label
		}
		found = append(found, domain.MentionFound{
			ProposedLink: domain.ProposedLink{LinkType: linkType, Source: source, Target: target},
			Other:        other, Label: label, HolderIsSelf: inSelf, Field: mention.Field, Excerpt: mention.Excerpt,
		})
		if len(found) >= MaxMentions {
			break
		}
	}
	return found, nil
}

// Briefing is the extractive briefing of the record (engine "extractivo"); ok is false when the
// record does not exist or is not visible.
func Briefing(ctx context.Context, r Reader, slug, id string, now time.Time) (domain.Briefing, bool, error) {
	found, ok, err := Neighbours(ctx, r, slug, id)
	if err != nil || !ok {
		return domain.Briefing{}, false, err
	}
	return domain.BuildBriefing(found.Subject, found.Connections, Today(now)), true, nil
}

// Proposals is proposalsFor: the record's open proposals, follow-ups first, then links read from
// text, without those someone already decided; ok is false when the record does not exist.
func Proposals(ctx context.Context, r Reader, slug, id string, now time.Time) ([]domain.Proposal, bool, error) {
	found, ok, err := Neighbours(ctx, r, slug, id)
	if err != nil || !ok {
		return nil, false, err
	}
	mentions, err := Mentions(ctx, r, slug, id)
	if err != nil {
		return nil, false, err
	}
	all := domain.FollowUpProposals(found.Subject, found.Connections, Today(now))
	for _, m := range mentions {
		all = append(all, domain.MentionProposal(found.Subject, m))
	}
	if len(all) == 0 {
		return all, true, nil
	}
	fingerprints := make([]string, len(all))
	for i, p := range all {
		fingerprints[i] = p.Fingerprint
	}
	decided, err := r.Decided(ctx, fingerprints)
	if err != nil {
		return nil, false, err
	}
	open := []domain.Proposal{}
	for _, p := range all {
		if !decided[p.Fingerprint] {
			open = append(open, p)
		}
	}
	return open, true, nil
}

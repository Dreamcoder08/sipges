package application

import (
	"context"
	"strings"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// The write side of ontology-service.ts (link, setLinkEvidence, classify, unlink) and the
// neighbourhood POST, a read of several seeds. Every write runs in the request's tenant
// transaction, so row-level security decides which records and links exist: a record of
// another project, or one marked 'restringido' for a read-only clearance, reads as missing.

// MaxNeighbourhoodSeeds and MaxNeighbourhoodNodes bound the neighbourhood (ODD
// territorial-operations).
const (
	MaxNeighbourhoodSeeds = 100
	MaxNeighbourhoodNodes = 400
)

// NewLink is NewLink of ports.ts.
type NewLink struct {
	LinkType         string
	Source, Target   NodeRef
	Note             string
	Symmetric        bool
	CreatedBy        string
	AuditDetail      string
	EvidenceSourceID *string
}

// CreateProblem is why the store refused a link: an end or the evidence source is not
// visible, or the link exists (also reversed, for a symmetric type).
type CreateProblem string

// The store's refusals.
const (
	Missing   CreateProblem = "missing"
	Duplicate CreateProblem = "duplicate"
)

// Writer is the write half of OntologyStore; each call audits what it changes in the same
// tenant transaction (docs/adr/0003).
type Writer interface {
	CreateLink(ctx context.Context, link NewLink, at time.Time) (int64, CreateProblem, error)
	SetLinkEvidence(ctx context.Context, id int64, sourceID *string, at time.Time) (bool, error)
	SetMarking(ctx context.Context, ref NodeRef, marking string, at time.Time) (bool, error)
	DeleteLink(ctx context.Context, id int64, at time.Time) (bool, error)
}

// Writes are the ontology writes over one tenant transaction, at the instant Now gives.
type Writes struct {
	Store Writer
	Now   time.Time
}

// LinkInput is the link input of ontology-service.ts, by slugs.
type LinkInput struct {
	LinkType       string
	Source, Target domain.Ref
	Note           string
	Evidence       *domain.Ref
}

// Link is link: problem is a domain.LinkProblem or a CreateProblem when refused, else id is
// the new link.
func (w Writes) Link(ctx context.Context, in LinkInput, actor string) (int64, string, error) {
	if problem := domain.CheckLink(in.LinkType, in.Source, in.Target); problem != "" {
		return 0, string(problem), nil
	}
	source, ok := refFor(in.Source.Module, in.Source.ID)
	target, ok2 := refFor(in.Target.Module, in.Target.ID)
	linkType, ok3 := domain.LinkTypeByID(in.LinkType)
	if !ok || !ok2 || !ok3 {
		return 0, string(Missing), nil
	}
	var evidence *string
	if in.Evidence != nil {
		id := in.Evidence.ID
		evidence = &id
	}
	id, problem, err := w.Store.CreateLink(ctx, NewLink{
		LinkType: linkType.ID, Source: source, Target: target,
		Note:             strings.TrimFunc(in.Note, js.IsJSSpace),
		EvidenceSourceID: evidence,
		Symmetric:        linkType.Symmetric,
		CreatedBy:        actor,
		AuditDetail:      source.Module + " " + source.ID + " " + linkType.Label + " " + target.Module + " " + target.ID,
	}, w.Now)
	return id, string(problem), err
}

// Classify is classify: false when the record is not visible (or the slug, id or marking is
// not one the catalog knows).
func (w Writes) Classify(ctx context.Context, slug, id, marking string) (bool, error) {
	ref, ok := refFor(slug, id)
	if !ok || !domain.IsMarking(marking) {
		return false, nil
	}
	return w.Store.SetMarking(ctx, ref, marking, w.Now)
}

// SetLinkEvidence is setLinkEvidence: false when the link, an end or the source is not visible.
func (w Writes) SetLinkEvidence(ctx context.Context, id int64, sourceID *string) (bool, error) {
	return w.Store.SetLinkEvidence(ctx, id, sourceID, w.Now)
}

// Unlink is unlink: false when the link does not exist.
func (w Writes) Unlink(ctx context.Context, id int64) (bool, error) {
	return w.Store.DeleteLink(ctx, id, w.Now)
}

// Neighbourhood is the joint neighbourhood of several records.
type Neighbourhood struct {
	Seeds     []domain.Ref
	Nodes     []domain.Summary
	Edges     []Edge
	Truncated bool
}

// Neighbourhood is neighbourhood: hops lists the link types each hop follows; seeds that do
// not exist or are not visible are left out; fields adds payload fields to every summary.
func (s Service) Neighbourhood(ctx context.Context, seeds []domain.Ref, hops [][]string, fields []string) (*Neighbourhood, error) {
	roots := []NodeRef{}
	seen := map[string]bool{}
	for _, seed := range seeds[:min(len(seeds), MaxNeighbourhoodSeeds)] {
		if ref, ok := refFor(seed.Module, seed.ID); ok && !seen[key(ref)] {
			seen[key(ref)] = true
			roots = append(roots, ref)
		}
	}
	nodes, edges, truncated, err := s.explore(ctx, roots, hops, MaxNeighbourhoodNodes, fields)
	if err != nil {
		return nil, err
	}
	present := map[string]bool{}
	for _, n := range nodes {
		present[n.Module+"\x00"+n.ID] = true
	}
	out := &Neighbourhood{Seeds: []domain.Ref{}, Nodes: nodes, Edges: edges, Truncated: truncated}
	for _, seed := range seeds {
		if present[seed.Module+"\x00"+seed.ID] {
			out.Seeds = append(out.Seeds, seed)
		}
	}
	return out, nil
}

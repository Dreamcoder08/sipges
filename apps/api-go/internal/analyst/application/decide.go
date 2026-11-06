package application

import (
	"context"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
)

// What a decision can refuse: decide's error of analyst-service.ts.
const (
	DecideMissing = "missing"
	DecideTaken   = "decided"
	DecideFailed  = "failed"
)

// What approving a link can do.
const (
	LinkCreated   = "created"
	LinkDuplicate = "duplicate"
	LinkFailed    = "failed"
)

const approvedNote = "Propuesta del analista aprobada"

// ProposalActions writes an approved proposal through the owning contexts, which audit it.
type ProposalActions interface {
	// Link answers LinkCreated, LinkDuplicate or LinkFailed.
	Link(ctx context.Context, tenantID string, link domain.ProposedLink, note, actor string) (string, error)
	// Create answers the new record's id, or "" when it could not be created.
	Create(ctx context.Context, tenantID string, record domain.ProposedRecord) (string, error)
}

// ProposalDecision is one decided proposal; Result is what an approval produced.
type ProposalDecision struct {
	Fingerprint, SubjectSlug, SubjectID, Kind, Decision string
	Result                                              *string
	Title, Actor                                        string
	At                                                  time.Time
}

// DecisionStore stores a decision with its audit row; false when someone already decided it.
type DecisionStore interface {
	Save(ctx context.Context, tenantID string, decision ProposalDecision) (bool, error)
}

// OpenProposals reads the subject's open proposals; false when the record is not visible.
type OpenProposals func(ctx context.Context) ([]domain.Proposal, bool, error)

// DecisionInput is decide's input.
type DecisionInput struct {
	Slug, ID, Fingerprint string
	Approve               bool
}

// Deciding is decide of analyst-service.ts.
type Deciding struct {
	Actions ProposalActions
	Store   DecisionStore
}

// Decide applies or discards one proposal. The proposal is recomputed from current data, so only
// an action the analyst would offer right now can be approved. kind is "" on success; result is
// the record an approval created. Each step has its own tenant transaction, as in TypeScript.
func (d Deciding) Decide(ctx context.Context, tenantID string, open OpenProposals, in DecisionInput, actor string, at time.Time) (result *string, kind string, err error) {
	proposals, found, err := open(ctx)
	if err != nil {
		return nil, "", err
	}
	proposal, ok := proposalOf(proposals, in.Fingerprint)
	if !found || !ok {
		return nil, DecideMissing, nil
	}
	decision := "rejected"
	if in.Approve {
		decision = "approved"
		if proposal.Link != nil {
			outcome, err := d.Actions.Link(ctx, tenantID, *proposal.Link, approvedNote, actor)
			if err != nil {
				return nil, "", err
			}
			if outcome == LinkFailed {
				return nil, DecideFailed, nil
			}
		} else if proposal.Record != nil {
			id, err := d.Actions.Create(ctx, tenantID, *proposal.Record)
			if err != nil {
				return nil, "", err
			}
			if id == "" {
				return nil, DecideFailed, nil
			}
			created := proposal.Record.Slug + "/" + id
			result = &created
		}
	}
	saved, err := d.Store.Save(ctx, tenantID, ProposalDecision{
		Fingerprint: proposal.Fingerprint, SubjectSlug: in.Slug, SubjectID: in.ID, Kind: proposal.Kind,
		Decision: decision, Result: result, Title: proposal.Title, Actor: actor, At: at,
	})
	if err != nil {
		return nil, "", err
	}
	if !saved {
		return nil, DecideTaken, nil
	}
	return result, "", nil
}

func proposalOf(proposals []domain.Proposal, fingerprint string) (domain.Proposal, bool) {
	for _, p := range proposals {
		if p.Fingerprint == fingerprint {
			return p, true
		}
	}
	return domain.Proposal{}, false
}

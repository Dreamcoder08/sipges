package application

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"
	"sync"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
)

// Proposals the Inicio analyst stores (odd/archive/agentic-analyst.md S4). Proposing stores a
// pending proposal and writes nothing else; a person decides it later through Deciding, with the
// same actions, decision row and audit as a computed proposal.

// DecideForbidden is a decision by a role that may not write the proposal's module.
const DecideForbidden = "forbidden"

// StoredProposal is a proposal the analyst made, pending while no decision names it.
type StoredProposal struct {
	ID         string
	Proposal   domain.Proposal
	ProposedBy string
	ProposedAt time.Time
}

// ProposalStore keeps the analyst's proposals of each tenant; it never writes records or links.
type ProposalStore interface {
	// Add stores p unless the tenant already has limit pending proposals (false).
	Add(ctx context.Context, tenantID string, p StoredProposal, limit int) (bool, error)
	// Pending lists the tenant's undecided proposals, oldest first.
	Pending(ctx context.Context, tenantID string) ([]StoredProposal, error)
	// Find reads one undecided proposal; false when it does not exist or was decided.
	Find(ctx context.Context, tenantID, id string) (StoredProposal, bool, error)
}

// ProposalRules are the write rules of the contexts that own records and links, checked when the
// analyst proposes so a proposal that the write would refuse never reaches a person.
type ProposalRules interface {
	// Record is "" when the record could be created in the tenant, else the refused rule.
	Record(tenantID string, record domain.ProposedRecord) string
	// Link is "" when the ontology allows the link, else the refused rule.
	Link(link domain.ProposedLink) string
}

// Proposing stores the analyst's proposals.
type Proposing struct {
	Store ProposalStore
	Rules ProposalRules
	// Now stamps the proposal; nil is time.Now.
	Now func() time.Time
	// NewID names the proposal; nil draws a random one.
	NewID func() string
}

func newProposalID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b) // crypto/rand.Read never fails (Go 1.24)
	return "AP-" + strings.ToUpper(hex.EncodeToString(b))
}

// Propose stores draft (from domain.RecordDraft or domain.LinkDraft) as pending for tenantID.
// refusal is the rule it broke, for the model to read; nothing is stored then.
func (p Proposing) Propose(ctx context.Context, tenantID, actor string, draft domain.Proposal) (id, refusal string, err error) {
	switch {
	case draft.Record != nil:
		refusal = p.Rules.Record(tenantID, *draft.Record)
	case draft.Link != nil:
		refusal = p.Rules.Link(*draft.Link)
	default:
		return "", domain.RefusedFields, nil
	}
	if refusal != "" {
		return "", domain.RefusedValidation + refusal, nil
	}
	id = newProposalID()
	if p.NewID != nil {
		id = p.NewID()
	}
	now := time.Now
	if p.Now != nil {
		now = p.Now
	}
	draft.Fingerprint = domain.StoredFingerprint(id)
	added, err := p.Store.Add(ctx, tenantID, StoredProposal{
		ID: id, Proposal: draft, ProposedBy: actor, ProposedAt: now().Truncate(time.Millisecond),
	}, domain.MaxPendingProposals)
	if err != nil {
		return "", "", err
	}
	if !added {
		return "", domain.RefusedTooMany, nil
	}
	return id, "", nil
}

// proposalLocks holds a mutex per stored proposal being decided, with the number of decisions
// holding or awaiting it; an entry lives exactly while that number is above zero.
var proposalLocks = struct {
	sync.Mutex
	held map[string]*proposalLock
}{held: map[string]*proposalLock{}}

type proposalLock struct {
	sync.Mutex
	users int
}

// lockProposal serialises the decisions of one proposal in this process.
func lockProposal(key string) func() {
	proposalLocks.Lock()
	l := proposalLocks.held[key]
	if l == nil {
		l = &proposalLock{}
		proposalLocks.held[key] = l
	}
	l.users++
	proposalLocks.Unlock()
	l.Lock()
	return func() {
		l.Unlock()
		proposalLocks.Lock()
		if l.users--; l.users == 0 {
			delete(proposalLocks.held, key)
		}
		proposalLocks.Unlock()
	}
}

// ProposalWritePath is the route that would make the proposal's write, whose role gate decides
// who may approve or discard it.
func ProposalWritePath(p domain.Proposal) string {
	if p.Record != nil {
		return "/api/" + p.Record.Slug
	}
	return "/system/links"
}

// DecideStored approves or discards the stored proposal id. mayWrite answers whether the person
// deciding may make the proposal's write; when not, nothing is written or recorded. Otherwise it
// is Decide, re-reading the proposal so one decided meanwhile is missing.
func (d Deciding) DecideStored(ctx context.Context, tenantID, id string, approve bool, actor string, mayWrite func(context.Context, domain.Proposal) bool) (*string, string, error) {
	// One decision of a proposal at a time in this process: the next one re-reads it after the
	// first saved its decision, so it finds it decided and writes nothing.
	unlock := lockProposal(tenantID + "\x00" + id)
	defer unlock()
	found, ok, err := d.Proposals.Find(ctx, tenantID, id)
	if err != nil || !ok {
		return nil, DecideMissing, err
	}
	if !mayWrite(ctx, found.Proposal) {
		return nil, DecideForbidden, nil
	}
	open := func(ctx context.Context) ([]domain.Proposal, bool, error) {
		current, ok, err := d.Proposals.Find(ctx, tenantID, id)
		if err != nil || !ok {
			return nil, false, err
		}
		return []domain.Proposal{current.Proposal}, true, nil
	}
	subject := found.Proposal.Kind
	if found.Proposal.Record != nil {
		subject = found.Proposal.Record.Slug
	} else if found.Proposal.Link != nil {
		subject = found.Proposal.Link.Source.Slug
	}
	return d.Decide(ctx, tenantID, open, DecisionInput{
		Slug: subject, ID: id, Fingerprint: domain.StoredFingerprint(id), Approve: approve,
	}, actor)
}

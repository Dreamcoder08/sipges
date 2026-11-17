package application_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
)

// fakeProposals is an in-memory store of the analyst's stored proposals; decided ones are
// filtered by the decisions a fakeStore saved, as the SQL store joins proposal_decisions.
type fakeProposals struct {
	added   []application.StoredProposal
	limit   int
	decided *fakeStore
}

func (f *fakeProposals) Add(_ context.Context, _ string, p application.StoredProposal, limit int) (bool, error) {
	f.limit = limit
	if len(f.added) >= limit {
		return false, nil
	}
	f.added = append(f.added, p)
	return true, nil
}

func (f *fakeProposals) Pending(ctx context.Context, tenantID string) ([]application.StoredProposal, error) {
	var out []application.StoredProposal
	for _, p := range f.added {
		if _, ok, _ := f.Find(ctx, tenantID, p.ID); ok {
			out = append(out, p)
		}
	}
	return out, nil
}

func (f *fakeProposals) Find(_ context.Context, _ string, id string) (application.StoredProposal, bool, error) {
	for _, p := range f.added {
		if p.ID != id {
			continue
		}
		for _, d := range f.decided.saved {
			if d.Fingerprint == domain.StoredFingerprint(id) {
				return application.StoredProposal{}, false, nil
			}
		}
		return p, true, nil
	}
	return application.StoredProposal{}, false, nil
}

type fakeRules struct{ refusal string }

func (f fakeRules) Record(string, domain.ProposedRecord) string { return f.refusal }
func (f fakeRules) Link(domain.ProposedLink) string             { return f.refusal }

func recordDraft(t *testing.T) domain.Proposal {
	t.Helper()
	p, refusal := domain.RecordDraft(domain.ProposedRecord{Slug: "acciones", Payload: []domain.Field{{Key: "Accion", Value: "Visitar"}}}, "motivo")
	if refusal != "" {
		t.Fatal(refusal)
	}
	return p
}

func proposing(store *fakeProposals, rules fakeRules) application.Proposing {
	return application.Proposing{Store: store, Rules: rules, Now: func() time.Time { return at }, NewID: func() string { return "AP-1" }}
}

func TestProposingStoresAPendingProposalAndWritesNothingElse(t *testing.T) {
	t.Parallel()
	store := &fakeProposals{decided: &fakeStore{}}
	id, refusal, err := proposing(store, fakeRules{}).Propose(t.Context(), tenant, "solo", recordDraft(t))
	if err != nil || refusal != "" || id != "AP-1" {
		t.Fatalf("id %q, refusal %q, err %v", id, refusal, err)
	}
	got := store.added[0]
	if got.ProposedBy != "solo" || !got.ProposedAt.Equal(at) || got.Proposal.Fingerprint != "stored:AP-1" || store.limit != domain.MaxPendingProposals {
		t.Fatalf("stored %+v (limit %d)", got, store.limit)
	}
}

func TestProposingRefusesWhatTheWriteRulesRefuseOrPastTheLimit(t *testing.T) {
	t.Parallel()
	store := &fakeProposals{decided: &fakeStore{}}
	if _, refusal, _ := proposing(store, fakeRules{refusal: "Plazo no válido"}).Propose(t.Context(), tenant, "solo", recordDraft(t)); refusal != domain.RefusedValidation+"Plazo no válido" || len(store.added) != 0 {
		t.Fatalf("refusal %q, stored %v", refusal, store.added)
	}
	full := &fakeProposals{decided: &fakeStore{}, added: make([]application.StoredProposal, domain.MaxPendingProposals)}
	if _, refusal, _ := proposing(full, fakeRules{}).Propose(t.Context(), tenant, "solo", recordDraft(t)); refusal != domain.RefusedTooMany {
		t.Fatalf("refusal %q", refusal)
	}
}

func decideStored(t *testing.T, store *fakeProposals, actions *fakeActions, approve, mayWrite bool) (*string, string) {
	t.Helper()
	d := application.Deciding{Actions: actions, Store: store.decided, Proposals: store, Now: func() time.Time { return at }}
	result, kind, err := d.DecideStored(t.Context(), tenant, "AP-1", approve, "multi", func(context.Context, domain.Proposal) bool { return mayWrite })
	if err != nil {
		t.Fatal(err)
	}
	return result, kind
}

func stored(t *testing.T) *fakeProposals {
	t.Helper()
	store := &fakeProposals{decided: &fakeStore{}}
	if _, refusal, err := proposing(store, fakeRules{}).Propose(t.Context(), tenant, "solo", recordDraft(t)); err != nil || refusal != "" {
		t.Fatal(refusal, err)
	}
	return store
}

func TestApprovingAStoredProposalWritesOnceThroughTheActionsAndAudits(t *testing.T) {
	t.Parallel()
	store, actions := stored(t), &fakeActions{created: "AC-9"}
	result, kind := decideStored(t, store, actions, true, true)
	if kind != "" || result == nil || *result != "acciones/AC-9" {
		t.Fatalf("result %v, kind %q", result, kind)
	}
	if len(actions.calls) != 1 || actions.calls[0] != "create "+tenant+" acciones" {
		t.Fatalf("actions %v", actions.calls)
	}
	saved := store.decided.saved
	if len(saved) != 1 || saved[0].Fingerprint != "stored:AP-1" || saved[0].Decision != "approved" ||
		saved[0].SubjectSlug != "acciones" || saved[0].SubjectID != "AP-1" || saved[0].Actor != "multi" {
		t.Fatalf("saved %+v", saved)
	}
	if _, kind := decideStored(t, store, actions, true, true); kind != application.DecideMissing || len(actions.calls) != 1 {
		t.Fatalf("second approval: kind %q, actions %v", kind, actions.calls)
	}
}

func TestRejectingAStoredProposalWritesNothing(t *testing.T) {
	t.Parallel()
	store, actions := stored(t), &fakeActions{}
	if _, kind := decideStored(t, store, actions, false, true); kind != "" {
		t.Fatalf("kind %q", kind)
	}
	if len(actions.calls) != 0 || len(store.decided.saved) != 1 || store.decided.saved[0].Decision != "rejected" {
		t.Fatalf("actions %v, saved %+v", actions.calls, store.decided.saved)
	}
}

func TestARoleThatMayNotWriteTheModuleCannotDecide(t *testing.T) {
	t.Parallel()
	for _, approve := range []bool{true, false} {
		store, actions := stored(t), &fakeActions{created: "AC-9"}
		if _, kind := decideStored(t, store, actions, approve, false); kind != application.DecideForbidden {
			t.Fatalf("approve %v: kind %q", approve, kind)
		}
		if len(actions.calls) != 0 || len(store.decided.saved) != 0 {
			t.Fatalf("approve %v: actions %v, saved %v", approve, actions.calls, store.decided.saved)
		}
	}
}

func TestProposalWritePathIsTheOwningRoute(t *testing.T) {
	t.Parallel()
	if got := application.ProposalWritePath(recordDraft(t)); got != "/api/acciones" {
		t.Fatal(got)
	}
	if got := application.ProposalWritePath(domain.Proposal{Kind: "link", Link: &domain.ProposedLink{}}); got != "/system/links" {
		t.Fatal(got)
	}
}

// slowActions counts creates and holds each one, so concurrent approvals overlap.
type slowActions struct {
	mu      sync.Mutex
	creates int
}

func (s *slowActions) Link(context.Context, string, domain.ProposedLink, string, string) (string, error) {
	return application.LinkCreated, nil
}

func (s *slowActions) Create(context.Context, string, domain.ProposedRecord) (string, error) {
	s.mu.Lock()
	s.creates++
	s.mu.Unlock()
	time.Sleep(20 * time.Millisecond)
	return "AC-9", nil
}

// lockedProposals guards the fakes for concurrent use.
type lockedProposals struct {
	mu    sync.Mutex
	inner *fakeProposals
}

func (l *lockedProposals) Add(ctx context.Context, tenantID string, p application.StoredProposal, limit int) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.inner.Add(ctx, tenantID, p, limit)
}

func (l *lockedProposals) Pending(ctx context.Context, tenantID string) ([]application.StoredProposal, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.inner.Pending(ctx, tenantID)
}

func (l *lockedProposals) Find(ctx context.Context, tenantID, id string) (application.StoredProposal, bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.inner.Find(ctx, tenantID, id)
}

type lockedDecisions struct {
	mu    *sync.Mutex
	inner *fakeStore
}

func (l lockedDecisions) Save(ctx context.Context, tenantID string, d application.ProposalDecision) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, s := range l.inner.saved {
		if s.Fingerprint == d.Fingerprint {
			return false, nil
		}
	}
	return l.inner.Save(ctx, tenantID, d)
}

func TestConcurrentApprovalsOfOneStoredProposalWriteOnce(t *testing.T) {
	t.Parallel()
	inner := stored(t)
	proposals := &lockedProposals{inner: inner}
	actions := &slowActions{}
	d := application.Deciding{Actions: actions, Store: lockedDecisions{&proposals.mu, inner.decided}, Proposals: proposals}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			_, _, err := d.DecideStored(t.Context(), tenant, "AP-1", true, "multi", func(context.Context, domain.Proposal) bool { return true })
			if err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if actions.creates != 1 {
		t.Fatalf("%d creates for one proposal", actions.creates)
	}
}

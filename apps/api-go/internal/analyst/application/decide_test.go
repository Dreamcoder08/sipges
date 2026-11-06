package application_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
)

type fakeActions struct {
	calls   []string
	outcome string
	created string
	err     error
}

func (f *fakeActions) Link(_ context.Context, tenantID string, link domain.ProposedLink, note, actor string) (string, error) {
	f.calls = append(f.calls, "link "+tenantID+" "+link.LinkType+" "+note+" "+actor)
	return f.outcome, f.err
}

func (f *fakeActions) Create(_ context.Context, tenantID string, record domain.ProposedRecord) (string, error) {
	f.calls = append(f.calls, "create "+tenantID+" "+record.Slug)
	return f.created, f.err
}

type fakeStore struct {
	saved []application.ProposalDecision
	taken bool
	err   error
}

func (f *fakeStore) Save(_ context.Context, _ string, d application.ProposalDecision) (bool, error) {
	f.saved = append(f.saved, d)
	return !f.taken, f.err
}

var (
	linkProposal = domain.Proposal{
		Fingerprint: "link:1", Kind: "link", Title: "Vincular",
		Link: &domain.ProposedLink{LinkType: "menciona"},
	}
	recordProposal = domain.Proposal{
		Fingerprint: "record:1", Kind: "record", Title: "Crear acción",
		Record: &domain.ProposedRecord{Slug: "acciones"},
	}
)

func openOf(found bool, proposals ...domain.Proposal) application.OpenProposals {
	return func(context.Context) ([]domain.Proposal, bool, error) { return proposals, found, nil }
}

func decide(t *testing.T, open application.OpenProposals, actions *fakeActions, store *fakeStore, fingerprint string, approve bool) (*string, string) {
	t.Helper()
	d := application.Deciding{Actions: actions, Store: store, Now: func() time.Time { return at }}
	result, kind, err := d.Decide(t.Context(), tenant, open, application.DecisionInput{
		Slug: "alertas", ID: "AL-1", Fingerprint: fingerprint, Approve: approve,
	}, "analista")
	if err != nil {
		t.Fatal(err)
	}
	return result, kind
}

func TestAnUnknownOrClosedProposalIsMissing(t *testing.T) {
	t.Parallel()
	for name, open := range map[string]application.OpenProposals{
		"record not visible": openOf(false),
		"no such proposal":   openOf(true, linkProposal),
	} {
		actions, store := &fakeActions{}, &fakeStore{}
		if _, kind := decide(t, open, actions, store, "record:1", true); kind != application.DecideMissing {
			t.Fatalf("%s: %q", name, kind)
		}
		if len(actions.calls) != 0 || len(store.saved) != 0 {
			t.Fatalf("%s: acted %v, saved %v", name, actions.calls, store.saved)
		}
	}
}

func TestApprovingALinkCreatesItAndRecordsTheDecision(t *testing.T) {
	t.Parallel()
	for _, outcome := range []string{application.LinkCreated, application.LinkDuplicate} {
		actions, store := &fakeActions{outcome: outcome}, &fakeStore{}
		result, kind := decide(t, openOf(true, linkProposal), actions, store, "link:1", true)
		if kind != "" || result != nil {
			t.Fatalf("%v %q", result, kind)
		}
		if len(actions.calls) != 1 || actions.calls[0] != "link "+tenant+" menciona Propuesta del analista aprobada analista" {
			t.Fatalf("calls = %v", actions.calls)
		}
		got := store.saved[0]
		want := application.ProposalDecision{
			Fingerprint: "link:1", SubjectSlug: "alertas", SubjectID: "AL-1", Kind: "link",
			Decision: "approved", Title: "Vincular", Actor: "analista", At: at,
		}
		if got != want {
			t.Fatalf("saved %+v", got)
		}
	}
}

func TestApprovingARecordCreatesItAndReportsIt(t *testing.T) {
	t.Parallel()
	actions, store := &fakeActions{created: "ACC-9"}, &fakeStore{}
	result, kind := decide(t, openOf(true, recordProposal), actions, store, "record:1", true)
	if kind != "" || result == nil || *result != "acciones/ACC-9" {
		t.Fatalf("%v %q", result, kind)
	}
	if store.saved[0].Result == nil || *store.saved[0].Result != "acciones/ACC-9" || store.saved[0].Kind != "record" {
		t.Fatalf("saved %+v", store.saved[0])
	}
}

func TestAFailedActionRecordsNothing(t *testing.T) {
	t.Parallel()
	for name, c := range map[string]struct {
		proposal domain.Proposal
		actions  *fakeActions
	}{
		"link":   {linkProposal, &fakeActions{outcome: application.LinkFailed}},
		"record": {recordProposal, &fakeActions{}},
	} {
		store := &fakeStore{}
		if _, kind := decide(t, openOf(true, c.proposal), c.actions, store, c.proposal.Fingerprint, true); kind != application.DecideFailed {
			t.Fatalf("%s: %q", name, kind)
		}
		if len(store.saved) != 0 {
			t.Fatalf("%s: saved %v", name, store.saved)
		}
	}
}

func TestRejectingOnlyRecordsTheDecision(t *testing.T) {
	t.Parallel()
	actions, store := &fakeActions{}, &fakeStore{}
	result, kind := decide(t, openOf(true, recordProposal), actions, store, "record:1", false)
	if kind != "" || result != nil || len(actions.calls) != 0 {
		t.Fatalf("%v %q %v", result, kind, actions.calls)
	}
	if store.saved[0].Decision != "rejected" || store.saved[0].Result != nil {
		t.Fatalf("saved %+v", store.saved[0])
	}
}

func TestAnotherPersonDecidedFirst(t *testing.T) {
	t.Parallel()
	if _, kind := decide(t, openOf(true, linkProposal), &fakeActions{outcome: application.LinkCreated}, &fakeStore{taken: true}, "link:1", true); kind != application.DecideTaken {
		t.Fatalf("kind = %q", kind)
	}
}

// awareStore and awareActions see the request ending between the two steps, as a client that
// goes away does: the action has committed by then, so the decision must still be saved.
type awareStore struct {
	fakeStore
	sawErr error
}

func (a *awareStore) Save(ctx context.Context, tenantID string, d application.ProposalDecision) (bool, error) {
	a.sawErr = ctx.Err()
	return a.fakeStore.Save(ctx, tenantID, d)
}

type awareActions struct {
	fakeActions
	cancel context.CancelFunc
	sawErr error
}

func (a *awareActions) Create(ctx context.Context, tenantID string, record domain.ProposedRecord) (string, error) {
	a.cancel()
	a.sawErr = ctx.Err()
	return a.fakeActions.Create(ctx, tenantID, record)
}

func TestALeavingClientDoesNotLoseACommittedDecision(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	actions := &awareActions{fakeActions: fakeActions{created: "ACC-9"}, cancel: cancel}
	store := &awareStore{}
	d := application.Deciding{Actions: actions, Store: store, Now: func() time.Time { return at }}
	input := application.DecisionInput{Slug: "alertas", ID: "AL-1", Fingerprint: "record:1", Approve: true}
	if _, kind, err := d.Decide(ctx, tenant, openOf(true, recordProposal), input, "a"); err != nil || kind != "" {
		t.Fatalf("%q %v", kind, err)
	}
	if actions.sawErr != nil || store.sawErr != nil || len(store.saved) != 1 {
		t.Fatalf("action saw %v, save saw %v, saved %d", actions.sawErr, store.sawErr, len(store.saved))
	}
}

func TestTheDecisionIsStampedAfterTheAction(t *testing.T) {
	t.Parallel()
	actions, store := &fakeActions{created: "ACC-9"}, &fakeStore{}
	stampedAfter := -1
	d := application.Deciding{Actions: actions, Store: store, Now: func() time.Time {
		stampedAfter = len(actions.calls)
		return at
	}}
	input := application.DecisionInput{Slug: "alertas", ID: "AL-1", Fingerprint: "record:1", Approve: true}
	if _, _, err := d.Decide(t.Context(), tenant, openOf(true, recordProposal), input, "a"); err != nil {
		t.Fatal(err)
	}
	if stampedAfter != 1 {
		t.Fatalf("the clock was read after %d actions", stampedAfter)
	}
}

func TestErrorsFailTheRequest(t *testing.T) {
	t.Parallel()
	boom := errors.New("db")
	d := application.Deciding{Actions: &fakeActions{err: boom}, Store: &fakeStore{}, Now: func() time.Time { return at }}
	input := application.DecisionInput{Fingerprint: "link:1", Approve: true}
	if _, _, err := d.Decide(t.Context(), tenant, openOf(true, linkProposal), input, "a"); !errors.Is(err, boom) {
		t.Fatalf("error = %v", err)
	}
	failing := func(context.Context) ([]domain.Proposal, bool, error) { return nil, false, boom }
	if _, _, err := d.Decide(t.Context(), tenant, failing, input, "a"); !errors.Is(err, boom) {
		t.Fatalf("error = %v", err)
	}
}

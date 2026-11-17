package application_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// RenameTenant satisfies the Store for the other administration tests; they never rename.
func (s *adminStore) RenameTenant(context.Context, domain.Scope, string, string, time.Time) (bool, error) {
	return true, nil
}

type renameCall struct {
	scope     domain.Scope
	label, by string
	at        time.Time
}

// renameStore records every rename; missing names projects the database no longer holds.
type renameStore struct {
	*adminStore
	calls   []renameCall
	missing bool
	fail    error
}

func (s *renameStore) RenameTenant(_ context.Context, sc domain.Scope, label, by string, at time.Time) (bool, error) {
	s.calls = append(s.calls, renameCall{sc, label, by, at})
	return !s.missing, s.fail
}

var sechura = domain.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-SECHURA"}

var renameAt = time.Date(2026, 1, 2, 3, 4, 5, 678_000_000, time.UTC)

func renameAdmin(granted ...domain.Scope) (application.Admin, *renameStore) {
	store := &renameStore{adminStore: &adminStore{fakeStore: &fakeStore{grants: map[string][]domain.Grant{}}}}
	for _, s := range granted {
		store.add("admin", domain.Grant{Scope: s, Label: "Proyecto principal"})
	}
	return application.Admin{Store: store, Now: func() time.Time { return renameAt.Add(321 * time.Microsecond) }}, store
}

func TestRenameStoresTheTrimmedLabelAsTheAdministrator(t *testing.T) {
	svc, store := renameAdmin(sechura)
	label, code, err := svc.RenameTenant(t.Context(), admin, sechura, "  Proyecto Sechura ")
	if err != nil || code != "" || label != "Proyecto Sechura" {
		t.Fatalf("rename = %q, %q, %v", label, code, err)
	}
	want := []renameCall{{sechura, "Proyecto Sechura", "admin", renameAt}}
	if len(store.calls) != 1 || store.calls[0] != want[0] {
		t.Fatalf("calls %+v, want %+v", store.calls, want)
	}
}

func TestRenameRefusesBeforeWriting(t *testing.T) {
	other := domain.Scope{CompanyID: "ACME", ProjectID: "SUR"}
	analyst := application.Actor{Username: "admin", Role: "analista"}
	cases := []struct {
		name    string
		actor   application.Actor
		scope   domain.Scope
		label   string
		granted []domain.Scope
		want    string
	}{
		{"not an administrator", analyst, sechura, "Nuevo", []domain.Scope{sechura}, application.ErrForbidden},
		{"not an administrator, blank label", analyst, sechura, " ", []domain.Scope{sechura}, application.ErrForbidden},
		{"blank label", admin, sechura, " \t ", []domain.Scope{sechura}, domain.ErrInvalidLabel},
		{"project the administrator cannot use", admin, other, "Nuevo", []domain.Scope{sechura}, application.ErrTenantMissing},
		{"unknown project", admin, domain.Scope{CompanyID: "NO", ProjectID: "PE"}, "Nuevo", []domain.Scope{sechura}, application.ErrTenantMissing},
		// A tenant id joins both ids with a slash; the grant must match the pair, not the text.
		{"same text, other pair", admin, domain.Scope{CompanyID: "SIPGES/PRJ", ProjectID: "SECHURA"}, "Nuevo",
			[]domain.Scope{{CompanyID: "SIPGES", ProjectID: "PRJ/SECHURA"}}, application.ErrTenantMissing},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			svc, store := renameAdmin(c.granted...)
			_, code, err := svc.RenameTenant(t.Context(), c.actor, c.scope, c.label)
			if err != nil || code != c.want {
				t.Fatalf("code %q, err %v; want %q", code, err, c.want)
			}
			if len(store.calls) != 0 {
				t.Fatalf("a refused rename wrote %+v", store.calls)
			}
		})
	}
}

func TestRenameOfAProjectDeletedMeanwhileIsMissing(t *testing.T) {
	svc, store := renameAdmin(sechura)
	store.missing = true
	if _, code, err := svc.RenameTenant(t.Context(), admin, sechura, "Nuevo"); err != nil || code != application.ErrTenantMissing {
		t.Fatalf("code %q, err %v", code, err)
	}
}

func TestRenameReportsAFailedWrite(t *testing.T) {
	svc, store := renameAdmin(sechura)
	store.fail = errors.New("database down")
	if _, _, err := svc.RenameTenant(t.Context(), admin, sechura, "Nuevo"); !errors.Is(err, store.fail) {
		t.Fatalf("err %v", err)
	}
}

package application_test

import (
	"context"
	"errors"
	"testing"
	"time"

	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// exportScope is a project the test grants through the store, never through the request cache.
var exportScope = domain.Scope{CompanyID: "EXP", ProjectID: "UNO"}

func exportAdmin(t *testing.T, granted bool, read application.ExportReader) application.Admin {
	t.Helper()
	store := &adminStore{fakeStore: &fakeStore{grants: map[string][]domain.Grant{}}}
	if granted {
		store.add("admin", domain.Grant{Scope: exportScope, Label: "Uno"})
	}
	return application.Admin{
		Store:  store,
		Export: read,
		Now:    func() time.Time { return time.Date(2026, 1, 2, 3, 4, 5, 999_000_000, time.UTC) },
	}
}

func TestExportReadsTheGrantFreshAndOnlyThenTheData(t *testing.T) {
	reads := 0
	read := func(_ context.Context, s domain.Scope) (*records.Object, error) {
		reads++
		if s != exportScope {
			t.Fatalf("read scope %v", s)
		}
		return records.NewObject(), nil
	}

	if _, code, err := exportAdmin(t, false, read).ExportData(t.Context(), admin, exportScope); err != nil || code != application.ErrForbidden {
		t.Fatalf("revoked grant: code %q, err %v", code, err)
	}
	analyst := application.Actor{Username: "admin", Role: "analista"}
	if _, code, err := exportAdmin(t, true, read).ExportData(t.Context(), analyst, exportScope); err != nil || code != application.ErrForbidden {
		t.Fatalf("not an administrator: code %q, err %v", code, err)
	}
	if reads != 0 {
		t.Fatalf("a refused export read the data %d times", reads)
	}

	got, code, err := exportAdmin(t, true, read).ExportData(t.Context(), admin, exportScope)
	if err != nil || code != "" {
		t.Fatalf("code %q, err %v", code, err)
	}
	want := `{"format":"sipges.tenant-export","version":1,"scope":{"company_id":"EXP","project_id":"UNO"},"exported_at":"2026-01-02T03:04:05Z","data":{}}`
	if string(records.Stringify(got)) != want {
		t.Fatalf("got %s", records.Stringify(got))
	}
}

func TestExportReportsAFailedRead(t *testing.T) {
	boom := errors.New("boom")
	read := func(context.Context, domain.Scope) (*records.Object, error) { return nil, boom }
	if _, _, err := exportAdmin(t, true, read).ExportData(t.Context(), admin, exportScope); !errors.Is(err, boom) {
		t.Fatalf("got %v", err)
	}
}

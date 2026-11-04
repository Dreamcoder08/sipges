package application_test

import (
	"context"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/domain"
)

func ptr(s string) *string { return &s }

func str(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

func TestNewFilterNormalizesLikeTheTypeScriptService(t *testing.T) {
	for _, c := range []struct {
		q                     application.ListQuery
		module, record, query string
		limit                 int64
		ok                    bool
	}{
		{application.ListQuery{Limit: 200}, "<nil>", "<nil>", "<nil>", 200, true},
		{application.ListQuery{LinkedModule: ptr("\u00a0 EVENTOS\ufeff"), Limit: 0}, "eventos", "<nil>", "<nil>", 1, true},
		{application.ListQuery{LinkedModule: ptr("İ"), Limit: 9999}, "i\u0307", "<nil>", "<nil>", 500, true},
		{application.ListQuery{LinkedModule: ptr("  "), LinkedRecordID: ptr(""), Q: ptr(""), Limit: -5}, "<nil>", "<nil>", "<nil>", 1, true},
		// The record id and q are used as given.
		{application.ListQuery{LinkedRecordID: ptr(" EV-1 "), Q: ptr(" A% "), Limit: 3}, "<nil>", " EV-1 ", " A% ", 3, true},
		{application.ListQuery{Q: ptr("a\x00"), Limit: 3}, "", "", "", 0, false},
		{application.ListQuery{LinkedRecordID: ptr("\x00"), Limit: 3}, "", "", "", 0, false},
		{application.ListQuery{LinkedModule: ptr("\x00"), Limit: 3}, "", "", "", 0, false},
	} {
		f, ok := application.NewFilter(c.q)
		if ok != c.ok {
			t.Errorf("%+v: ok = %v", c.q, ok)
			continue
		}
		if ok && (str(f.LinkedModule) != c.module || str(f.LinkedRecordID) != c.record || str(f.Q) != c.query || f.Limit != c.limit) {
			t.Errorf("%+v: got %s %s %s %d", c.q, str(f.LinkedModule), str(f.LinkedRecordID), str(f.Q), f.Limit)
		}
	}
}

func TestValidIDCountsUTF16Units(t *testing.T) {
	for id, want := range map[string]bool{
		"ADJ-1":                       true,
		strings.Repeat("a", 64):       true,
		strings.Repeat("a", 65):       false,
		strings.Repeat("😀", 32):       true,
		strings.Repeat("😀", 32) + "a": false,
		"a\x00":                       false,
	} {
		if got := application.ValidID(id); got != want {
			t.Errorf("ValidID(%q) = %v", id, got)
		}
	}
}

type spy struct{ lists, gets int }

func (s *spy) List(context.Context, application.Filter) ([]domain.Attachment, error) {
	s.lists++
	return nil, nil
}

func (s *spy) Get(context.Context, string) (*domain.Attachment, error) {
	s.gets++
	return nil, nil
}

func TestUnmatchableInputNeverReachesTheStore(t *testing.T) {
	store := &spy{}
	service := application.Service{Store: store}
	got, err := service.List(t.Context(), application.ListQuery{Q: ptr("\x00"), Limit: 1})
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("List = %v, %v; want an empty list", got, err)
	}
	if a, err := service.Get(t.Context(), strings.Repeat("a", 65)); a != nil || err != nil {
		t.Fatalf("Get = %v, %v", a, err)
	}
	if store.lists != 0 || store.gets != 0 {
		t.Fatalf("store reached: %+v", store)
	}
}

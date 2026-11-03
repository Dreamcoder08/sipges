package domain_test

import (
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

func TestResolveScope(t *testing.T) {
	t.Parallel()
	a := domain.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-A"}
	b := domain.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-B"}
	two := []domain.Scope{a, b}
	cases := []struct {
		name           string
		header, cookie string
		grants         []domain.Scope
		want           *domain.Scope
	}{
		{"one grant, nothing requested", "", "", []domain.Scope{a}, &a},
		{"two grants, nothing requested", "", "", two, nil},
		{"no grants", "", "", nil, nil},
		{"header wins over cookie", "SIPGES/PRJ-B", "SIPGES/PRJ-A", two, &b},
		{"empty header falls back to cookie", "", "SIPGES/PRJ-A", two, &a},
		{"exact and case-sensitive", "sipges/prj-a", "", two, nil},
		{"requested but not granted", "OTHER/X", "", []domain.Scope{a}, nil},
	}
	for _, c := range cases {
		got := domain.ResolveScope(c.header, c.cookie, c.grants)
		if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
	if got := a.String(); got != "SIPGES/PRJ-A" {
		t.Errorf("String = %s", got)
	}
}

// BodyNamesOtherProject mirrors tenancy-middleware.ts: the first truthy of body.project_id,
// body.payload.Proyecto_ID, body.payload.project_id (JavaScript truthiness), compared with !==.
func TestBodyNamesOtherProject(t *testing.T) {
	t.Parallel()
	cases := []struct {
		body string
		want bool
	}{
		{`{"project_id":"P1"}`, false},
		{`{"project_id":"P2"}`, true},
		{`{"payload":{"Proyecto_ID":"P2"}}`, true},
		{`{"payload":{"project_id":"P1"}}`, false},
		{`{"project_id":"","payload":{"project_id":"P2"}}`, true},
		{`{"project_id":"P1","payload":{"Proyecto_ID":"P2"}}`, false},
		{`{"project_id":0,"payload":{"project_id":"P1"}}`, false},
		{`{"project_id":null}`, false},
		{`{"project_id":false}`, false},
		{`{"project_id":7}`, true},
		{`{"project_id":true}`, true},
		{`{"project_id":["P1"]}`, true},
		{`{"payload":"P2"}`, false},
		{`{"payload":["P2"]}`, false},
		{`[{"project_id":"P2"}]`, false},
		{`"P2"`, false},
		{`{}`, false},
		{`not json`, false},
		{``, false},
	}
	for _, c := range cases {
		if got := domain.BodyNamesOtherProject([]byte(c.body), "P1"); got != c.want {
			t.Errorf("BodyNamesOtherProject(%s) = %v, want %v", c.body, got, c.want)
		}
	}
}

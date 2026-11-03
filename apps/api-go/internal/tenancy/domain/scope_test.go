package domain_test

import (
	"strings"
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
func TestCheckBody(t *testing.T) {
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
		// JSON.parse accepts what encoding/json alone refuses: a UTF-8 BOM, numbers out of range.
		{"\ufeff{\"project_id\":\"P2\"}", true},
		{`{"payload":{"Proyecto_ID":"P2"},"x":1e400}`, true},
		{`{"project_id":1e400}`, true},
		{`{"project_id":1e-400,"payload":{"project_id":"P2"}}`, true},
		{`{"project_id":-0,"payload":{"project_id":"P1"}}`, false},
		{``, false},
	}
	for _, c := range cases {
		want := domain.BodyAllowed
		if c.want {
			want = domain.BodyOtherProject
		}
		if got := domain.CheckBody([]byte(c.body), "P1"); got != want {
			t.Errorf("CheckBody(%s) = %v, want %v", c.body, got, want)
		}
	}
}

// encoding/json stops at 10,000 levels where JSON.parse goes on: the check cannot tell which
// project such a body names, so it fails closed instead of letting it through.
func TestCheckBodyFailsClosedOnNestingGoCannotRead(t *testing.T) {
	t.Parallel()
	deep := `{"project_id":"P1","x":` + strings.Repeat("[", 10001) + strings.Repeat("]", 10001) + `}`
	if got := domain.CheckBody([]byte(deep), "P1"); got != domain.BodyUndecidable {
		t.Fatalf("deep body = %v", got)
	}
	shallow := `{"project_id":"P1","x":` + strings.Repeat("[", 100) + strings.Repeat("]", 100) + `}`
	if got := domain.CheckBody([]byte(shallow), "P1"); got != domain.BodyAllowed {
		t.Fatalf("shallow body = %v", got)
	}
}

package domain_test

import (
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

func grant(company, project string) domain.Grant {
	return domain.Grant{Scope: domain.Scope{CompanyID: company, ProjectID: project}}
}

func TestResolveScope(t *testing.T) {
	sechura := grant("SIPGES", "PRJ-SECHURA")
	norte := grant("ACME", "NORTE")
	cases := []struct {
		name           string
		header, cookie string
		grants         []domain.Grant
		want           string
	}{
		{"sole grant when nothing is requested", "", "", []domain.Grant{sechura}, "SIPGES/PRJ-SECHURA"},
		{"several grants need a choice", "", "", []domain.Grant{norte, sechura}, ""},
		{"no grants", "", "", nil, ""},
		{"header wins over cookie", "ACME/NORTE", "SIPGES/PRJ-SECHURA", []domain.Grant{norte, sechura}, "ACME/NORTE"},
		{"cookie when no header", "", "SIPGES/PRJ-SECHURA", []domain.Grant{norte, sechura}, "SIPGES/PRJ-SECHURA"},
		{"ungranted header is refused, not replaced by the sole grant", "EVIL/CORP", "", []domain.Grant{sechura}, ""},
		{"ungranted header is refused even with a granted cookie", "EVIL/CORP", "SIPGES/PRJ-SECHURA", []domain.Grant{sechura}, ""},
		{"exact match only", "sipges/prj-sechura", "", []domain.Grant{sechura}, ""},
		{"split at the first slash", "SIPGES/PRJ-SECHURA/x", "", []domain.Grant{sechura}, ""},
	}
	for _, c := range cases {
		got, ok := domain.ResolveScope(c.header, c.cookie, c.grants)
		if (c.want == "") == ok || (ok && got.TenantID() != c.want) {
			t.Errorf("%s: got %q %v, want %q", c.name, got.TenantID(), ok, c.want)
		}
	}
}

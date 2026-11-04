package domain_test

import (
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// scope.ts validateNewTenant (app.py:355-361): ids first, then the reserved default project,
// then the label cut to 120 UTF-16 code units.
func TestValidateNewTenant(t *testing.T) {
	tenant := func(company, project, label string) domain.NewTenant {
		return domain.NewTenant{Scope: domain.Scope{CompanyID: company, ProjectID: project}, Label: label, Username: "ana"}
	}
	cases := []struct {
		name      string
		in        domain.NewTenant
		wantErr   string
		wantLabel string
	}{
		{"valid", tenant("ACME", "NORTE", "Norte"), "", "Norte"},
		{"one character", tenant("A", "NORTE", ""), domain.ErrInvalidIDs, ""},
		{"64 characters", tenant("ACME", strings.Repeat("P", 64), ""), "", ""},
		{"65 characters", tenant("ACME", strings.Repeat("P", 65), ""), domain.ErrInvalidIDs, ""},
		{"space", tenant("ACME", "has space", ""), domain.ErrInvalidIDs, ""},
		{"trailing newline", tenant("ACME\n", "NORTE", ""), domain.ErrInvalidIDs, ""},
		{"accented", tenant("ÁCME", "NORTE", ""), domain.ErrInvalidIDs, ""},
		{"slash", tenant("AC/ME", "NORTE", ""), domain.ErrInvalidIDs, ""},
		{"reserved", tenant("SIPGES", "PRJ-SECHURA", ""), domain.ErrReserved, ""},
		{"reserved is case sensitive", tenant("sipges", "PRJ-SECHURA", ""), "", ""},
		{"invalid wins over reserved", tenant("S", "PRJ-SECHURA", ""), domain.ErrInvalidIDs, ""},
		{"label cut", tenant("ACME", "NORTE", strings.Repeat("L", 130)), "", strings.Repeat("L", 120)},
		{"label cut inside an astral character", tenant("ACME", "NORTE", strings.Repeat("L", 119)+"😀tail"), "", strings.Repeat("L", 119) + "�"},
		{"label of astral characters", tenant("ACME", "NORTE", strings.Repeat("😀", 61)), "", strings.Repeat("😀", 60)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := domain.ValidateNewTenant(c.in)
			if err != c.wantErr {
				t.Fatalf("error = %q, want %q", err, c.wantErr)
			}
			if err == "" && got.Label != c.wantLabel {
				t.Fatalf("label = %q, want %q", got.Label, c.wantLabel)
			}
		})
	}
}

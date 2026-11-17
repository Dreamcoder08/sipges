package domain_test

import (
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// A project's new display name: trimmed as String.prototype.trim does, refused when nothing is
// left, then cut to the 120 UTF-16 code units of project creation.
func TestValidateLabel(t *testing.T) {
	cases := []struct {
		name, in, want, wantErr string
	}{
		{"kept", "Proyecto Sechura", "Proyecto Sechura", ""},
		{"trimmed", " \t Proyecto Alfarrobo \n", "Proyecto Alfarrobo", ""},
		{"inner spaces kept", "Proyecto  Sechura", "Proyecto  Sechura", ""},
		{"empty", "", "", domain.ErrInvalidLabel},
		{"blank", " \t\r\n ", "", domain.ErrInvalidLabel},
		{"no-break, ideographic and byte-order-mark spaces are blank", "\u00a0\u3000" + string(rune(0xFEFF)), "", domain.ErrInvalidLabel},
		{"next line is not a JavaScript space", "\u0085", "\u0085", ""},
		{"cut to 120", strings.Repeat("L", 130), strings.Repeat("L", 120), ""},
		{"cut inside an astral character", strings.Repeat("L", 119) + "\U0001F600tail", strings.Repeat("L", 119) + "\uFFFD", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, code := domain.ValidateLabel(c.in)
			if code != c.wantErr || got != c.want {
				t.Fatalf("ValidateLabel(%q) = %q, %q; want %q, %q", c.in, got, code, c.want, c.wantErr)
			}
		})
	}
}

func TestRenameDetailNamesBothLabelsAndTheActor(t *testing.T) {
	got := domain.RenameDetail("Proyecto principal", "Proyecto Sechura", "admin")
	want := "Proyecto renombrado de «Proyecto principal» a «Proyecto Sechura» por admin"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

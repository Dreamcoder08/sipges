package domain_test

import (
	"math"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/indicators/domain"
)

// PyFloat against pyFloat in apps/api/src/contexts/indicators/domain/python.ts (Node 22).
func TestPyFloat(t *testing.T) {
	for _, c := range []struct {
		in   float64
		want string
	}{
		{0, "0.0"}, {math.Copysign(0, -1), "0.0"}, {25, "25.0"}, {-3, "-3.0"}, {9.4, "9.4"},
		{16.66, "16.66"}, {1e20, "100000000000000000000.0"}, {1e21, "1e+21"}, {-1e21, "-1e+21"},
		{1e-7, "1e-7"}, {0.000001, "0.000001"}, {math.Inf(1), "Infinity"}, {math.NaN(), "NaN"},
	} {
		if got := domain.PyFloat(c.in); got != c.want {
			t.Errorf("PyFloat(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

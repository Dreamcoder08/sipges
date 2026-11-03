package application

import (
	"math"
	"testing"
)

func TestLatestLimitClampsToTheCeilingAndReadsNegativeAsTheCeiling(t *testing.T) {
	cases := map[int64]int{
		0:             0,
		1:             1,
		100:           100,
		500:           500,
		501:           500,
		-1:            500,
		math.MaxInt64: 500,
		math.MinInt64: 500,
	}
	for in, want := range cases {
		if got := LatestLimit(in); got != want {
			t.Errorf("LatestLimit(%d) = %d, want %d", in, got, want)
		}
	}
}

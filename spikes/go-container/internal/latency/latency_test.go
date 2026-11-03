package latency_test

import (
	"testing"
	"time"

	"github.com/dreamcoder08/sipges/spikes/go-container/internal/latency"
)

func ms(values ...float64) []time.Duration {
	out := make([]time.Duration, len(values))
	for i, v := range values {
		out[i] = time.Duration(v * float64(time.Millisecond))
	}
	return out
}

func TestSummarize(t *testing.T) {
	hundred := make([]float64, 100)
	for i := range hundred {
		hundred[99-i] = float64(i + 1) // 100..1, unsorted on purpose
	}
	tests := []struct {
		name    string
		samples []time.Duration
		want    latency.Summary
	}{
		{name: "empty", samples: nil, want: latency.Summary{}},
		{name: "single", samples: ms(7), want: latency.Summary{Count: 1, MinMs: 7, P50Ms: 7, P95Ms: 7, MaxMs: 7}},
		{name: "nearest rank on 1..100", samples: ms(hundred...), want: latency.Summary{Count: 100, MinMs: 1, P50Ms: 50, P95Ms: 95, MaxMs: 100}},
		{name: "small sample rounds rank up", samples: ms(4, 1, 3, 2), want: latency.Summary{Count: 4, MinMs: 1, P50Ms: 2, P95Ms: 4, MaxMs: 4}},
		{name: "sub-millisecond precision", samples: ms(0.25, 0.5), want: latency.Summary{Count: 2, MinMs: 0.25, P50Ms: 0.25, P95Ms: 0.5, MaxMs: 0.5}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := latency.Summarize(tt.samples); got != tt.want {
				t.Fatalf("Summarize() = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestSummarizeDoesNotReorderInput(t *testing.T) {
	samples := ms(3, 1, 2)
	latency.Summarize(samples)
	if samples[0] != 3*time.Millisecond || samples[1] != time.Millisecond {
		t.Fatalf("input was reordered: %v", samples)
	}
}

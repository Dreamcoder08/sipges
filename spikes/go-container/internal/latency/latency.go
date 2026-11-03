// Package latency summarises a series of measured durations.
package latency

import (
	"math"
	"slices"
	"time"
)

// Summary holds order statistics of a sample, in milliseconds.
type Summary struct {
	Count int     `json:"count"`
	MinMs float64 `json:"minMs"`
	P50Ms float64 `json:"p50Ms"`
	P95Ms float64 `json:"p95Ms"`
	MaxMs float64 `json:"maxMs"`
}

// Summarize returns the order statistics of samples using the nearest-rank
// percentile, so every reported value is one that was actually observed.
// The input slice is not modified.
func Summarize(samples []time.Duration) Summary {
	if len(samples) == 0 {
		return Summary{}
	}
	sorted := slices.Clone(samples)
	slices.Sort(sorted)
	return Summary{
		Count: len(sorted),
		MinMs: toMs(sorted[0]),
		P50Ms: toMs(nearestRank(sorted, 50)),
		P95Ms: toMs(nearestRank(sorted, 95)),
		MaxMs: toMs(sorted[len(sorted)-1]),
	}
}

func nearestRank(sorted []time.Duration, percentile float64) time.Duration {
	rank := int(math.Ceil(percentile / 100 * float64(len(sorted))))
	return sorted[max(rank, 1)-1]
}

func toMs(d time.Duration) float64 {
	return float64(d) / float64(time.Millisecond)
}

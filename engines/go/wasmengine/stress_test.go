package wasmengine_test

import (
	"bytes"
	"context"
	"os"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/engines/go/wasmengine"
)

// stressCalls is the number of calls per stress test; SIPGES_STRESS_CALLS raises it locally.
func stressCalls(t *testing.T, fallback int) int {
	t.Helper()
	if raw := os.Getenv("SIPGES_STRESS_CALLS"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			t.Fatalf("SIPGES_STRESS_CALLS=%q is not a positive integer", raw)
		}
		return n
	}
	return fallback
}

func percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	return sorted[min(len(sorted)-1, int(p*float64(len(sorted))))]
}

// Many goroutines over a small pool: every response must equal the TypeScript fixture.
func TestStressConcurrentCallsStayByteIdentical(t *testing.T) {
	const workers, instances = 32, 4
	calls := stressCalls(t, 600)
	engine := newEngine(t, wasmengine.Options{MaxInstances: instances})
	cases := loadCases(t)
	var next atomic.Int64
	var mu sync.Mutex
	latencies := make([]time.Duration, 0, calls)
	var failures atomic.Int64
	var wg sync.WaitGroup
	start := time.Now()
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				i := int(next.Add(1)) - 1
				if i >= calls {
					return
				}
				tc := cases[i%len(cases)]
				began := time.Now()
				got, err := engine.Invoke(context.Background(), []byte(tc.Request))
				took := time.Since(began)
				if err != nil || (tc.Compare == "bytes" && !bytes.Equal(got, []byte(tc.Response))) {
					if failures.Add(1) <= 3 {
						t.Errorf("%s: err=%v, response matches=%v", tc.Name, err, bytes.Equal(got, []byte(tc.Response)))
					}
				}
				mu.Lock()
				latencies = append(latencies, took)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	wall := time.Since(start)
	slices.Sort(latencies)
	t.Logf("%d calls, %d workers, %d instances: %.0f calls/s; latency p50 %v p95 %v p99 %v max %v; failures %d",
		calls, workers, instances, float64(calls)/wall.Seconds(),
		percentile(latencies, 0.50), percentile(latencies, 0.95), percentile(latencies, 0.99),
		latencies[len(latencies)-1], failures.Load())
}

// A leaked request or response buffer would exhaust a 4 MiB linear memory within a few hundred
// calls (each round trip moves about 8 KiB); the calls must keep succeeding.
func TestStressRepeatedCallsDoNotLeakLinearMemory(t *testing.T) {
	engine := newEngine(t, wasmengine.Options{MaxInstances: 1, MemoryLimitPages: 64})
	calls := stressCalls(t, 2000)
	request := []byte(`{"op":"defaults"}`)
	for i := range calls {
		if _, err := engine.Call(context.Background(), request); err != nil {
			t.Fatalf("call %d failed (leak?): %v", i, err)
		}
	}
}

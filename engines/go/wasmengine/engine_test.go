package wasmengine_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/engines/go/wasmengine"
)

// The module built by `cargo build --release --target wasm32-wasip1 -p sipges-indicators-wasm`
// (override with SIPGES_ENGINE_WASM) and the fixtures from engines/fixtures/generate.ts.
const (
	defaultWasm  = "../../target/wasm32-wasip1/release/sipges_indicators_wasm.wasm"
	fixturesPath = "../../fixtures/indicators.json"
)

type fixtureCase struct {
	Name     string `json:"name"`
	Request  string `json:"request"`
	Response string `json:"response"`
	Compare  string `json:"compare"`
}

func loadWasm(t testing.TB) []byte {
	t.Helper()
	path := os.Getenv("SIPGES_ENGINE_WASM")
	if path == "" {
		path = defaultWasm
	}
	wasm, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		t.Fatalf("read engine module (build it with `cargo build --release --target wasm32-wasip1 -p sipges-indicators-wasm` in engines/): %v", err)
	}
	return wasm
}

func loadCases(t testing.TB) []fixtureCase {
	t.Helper()
	raw, err := os.ReadFile(fixturesPath)
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}
	var fixtures struct {
		Cases []fixtureCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatalf("decode fixtures: %v", err)
	}
	if len(fixtures.Cases) < 40 {
		t.Fatalf("expected the full fixture set, got %d cases", len(fixtures.Cases))
	}
	return fixtures.Cases
}

func newEngine(t testing.TB, opts wasmengine.Options) *wasmengine.Engine {
	t.Helper()
	ctx := context.Background()
	engine, err := wasmengine.New(ctx, loadWasm(t), opts)
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}
	t.Cleanup(func() {
		if err := engine.Close(ctx); err != nil {
			t.Errorf("close engine: %v", err)
		}
	})
	return engine
}

func errorCode(t *testing.T, response []byte) string {
	t.Helper()
	var envelope struct {
		OK    bool `json:"ok"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response, &envelope); err != nil {
		t.Fatalf("decode response %q: %v", response, err)
	}
	if envelope.OK {
		return ""
	}
	return envelope.Error.Code
}

func TestFixturesMatchTheTypeScriptEngineThroughWasm(t *testing.T) {
	engine := newEngine(t, wasmengine.Options{})
	for _, tc := range loadCases(t) {
		t.Run(tc.Name, func(t *testing.T) {
			got, err := engine.Invoke(context.Background(), []byte(tc.Request))
			if err != nil {
				t.Fatalf("invoke: %v", err)
			}
			if tc.Compare == "error_code" {
				if want, have := errorCode(t, []byte(tc.Response)), errorCode(t, got); have != want {
					t.Fatalf("error code = %q, want %q (response %s)", have, want, got)
				}
				return
			}
			if !bytes.Equal(got, []byte(tc.Response)) {
				at := 0
				for at < len(got) && at < len(tc.Response) && got[at] == tc.Response[at] {
					at++
				}
				t.Fatalf("response differs at byte %d of %d/%d", at, len(got), len(tc.Response))
			}
		})
	}
}

func TestCallReturnsTheValueOrATypedError(t *testing.T) {
	engine := newEngine(t, wasmengine.Options{})
	ctx := context.Background()
	tests := []struct {
		name    string
		request string
		value   string
		code    string
	}{
		{name: "value", request: `{"op":"select_band","irsa":30,"thresholds":{"Verde":[0,24.99],"Amarillo":[25,49.99]}}`, value: `"Amarillo"`},
		{name: "invalid json", request: `{"op":`, code: "invalid_request"},
		{name: "not an object", request: `[1,2]`, code: "invalid_request"},
		{name: "unknown op", request: `{"op":"nope"}`, code: "invalid_request"},
		{name: "missing records", request: `{"op":"indicators"}`, code: "invalid_input"},
		{name: "non-numeric weight", request: `{"op":"irsa_config_patch","patch":{"weights":{"G":"1"}}}`, code: "invalid_input"},
		{name: "empty request", request: ``, code: "invalid_request"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			value, err := engine.Call(ctx, []byte(tt.request))
			if tt.code == "" {
				if err != nil || string(value) != tt.value {
					t.Fatalf("Call = %s, %v; want %s", value, err, tt.value)
				}
				return
			}
			var engineErr *wasmengine.Error
			if !errors.As(err, &engineErr) || engineErr.Code != tt.code || engineErr.Message == "" {
				t.Fatalf("Call error = %v, want code %s with a message", err, tt.code)
			}
		})
	}
}

func TestConcurrentCallsGiveTheSameBytesAsSequentialOnes(t *testing.T) {
	engine := newEngine(t, wasmengine.Options{MaxInstances: 3})
	cases := loadCases(t)
	ctx := context.Background()
	const workers, rounds = 16, 3
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for w := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for r := range rounds {
				tc := cases[(w*rounds+r)%len(cases)]
				got, err := engine.Invoke(ctx, []byte(tc.Request))
				if err != nil {
					errs <- fmt.Errorf("%s: %w", tc.Name, err)
					return
				}
				if tc.Compare == "bytes" && !bytes.Equal(got, []byte(tc.Response)) {
					errs <- fmt.Errorf("%s: concurrent response differs", tc.Name)
					return
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}

func TestCanceledContextFailsWithoutBreakingTheEngine(t *testing.T) {
	for _, interruptible := range []bool{false, true} {
		t.Run(fmt.Sprintf("interruptible=%v", interruptible), func(t *testing.T) {
			engine := newEngine(t, wasmengine.Options{MaxInstances: 1, Interruptible: interruptible})
			request := []byte(`{"op":"defaults"}`)
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if _, err := engine.Invoke(ctx, request); !errors.Is(err, context.Canceled) {
				t.Fatalf("Invoke with a canceled context = %v, want context.Canceled", err)
			}
			if _, err := engine.Call(context.Background(), request); err != nil {
				t.Fatalf("engine unusable after a canceled call: %v", err)
			}
		})
	}
}

// bigRequest repeats the 3x synthetic records n times (about 0.3 MiB each).
func bigRequest(t *testing.T, n int) []byte {
	t.Helper()
	var request map[string]any
	for _, tc := range loadCases(t) {
		if tc.Name == "irsa/synthetic-3x-seed11-phase-weights" {
			if err := json.Unmarshal([]byte(tc.Request), &request); err != nil {
				t.Fatalf("decode fixture: %v", err)
			}
		}
	}
	records, _ := request["records"].(map[string]any)
	for module, rows := range records {
		list, _ := rows.([]any)
		grown := make([]any, 0, len(list)*n)
		for range n {
			grown = append(grown, list...)
		}
		records[module] = grown
	}
	raw, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}
	return raw
}

func TestInterruptibleCallStopsMidFlightAndTheEngineRecovers(t *testing.T) {
	// Retain up to the memory limit: the 5 MiB request grows the instance past the 16 MiB default,
	// which would discard the warmed instance and make the timed call instantiate a fresh one.
	engine := newEngine(t, wasmengine.Options{
		MaxInstances:      1,
		Interruptible:     true,
		RetainMemoryPages: wasmengine.DefaultMemoryLimitPages,
	})
	request := bigRequest(t, 16) // about 5 MiB: tens of milliseconds of work
	// Warm the instance first so the timed call measures only the computation.
	if _, err := engine.Invoke(context.Background(), request); err != nil {
		t.Fatalf("warm-up call failed: %v", err)
	}
	if got := engine.Stats(); got != (wasmengine.Stats{Live: 1, Idle: 1}) {
		t.Fatalf("after the warm-up Stats = %+v, want the warmed instance pooled", got)
	}
	start := time.Now()
	if _, err := engine.Invoke(context.Background(), request); err != nil {
		t.Fatalf("uninterrupted call failed: %v", err)
	}
	full := time.Since(start)
	ctx, cancel := context.WithTimeout(context.Background(), full/10)
	defer cancel()
	start = time.Now()
	_, err := engine.Invoke(ctx, request)
	stopped := time.Since(start)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Invoke past its deadline = %v, want context.DeadlineExceeded", err)
	}
	if stopped >= full {
		t.Fatalf("interrupted call took %v, as long as a full call (%v)", stopped, full)
	}
	if _, err := engine.Call(context.Background(), []byte(`{"op":"defaults"}`)); err != nil {
		t.Fatalf("engine unusable after an interrupted call: %v", err)
	}
}

// endsAfterFirstCheck is a context that is still live when Invoke first checks it and ends right
// after, the window in which a waiting caller can be handed an instance after its context ended.
type endsAfterFirstCheck struct {
	context.Context
	checks int
}

func (c *endsAfterFirstCheck) Err() error {
	c.checks++
	if c.checks == 1 {
		return nil
	}
	return context.Canceled
}

func TestContextThatEndsAfterAcquireDoesNotStartTheCall(t *testing.T) {
	for _, pooled := range []bool{true, false} {
		t.Run(fmt.Sprintf("pooled=%v", pooled), func(t *testing.T) {
			engine := newEngine(t, wasmengine.Options{MaxInstances: 1})
			request := []byte(`{"op":"defaults"}`)
			if pooled {
				if _, err := engine.Call(context.Background(), request); err != nil {
					t.Fatalf("warm-up call: %v", err)
				}
			}
			ctx := &endsAfterFirstCheck{Context: context.Background()}
			response, err := engine.Invoke(ctx, request)
			if !errors.Is(err, context.Canceled) || response != nil {
				t.Fatalf("Invoke = (%d response bytes, %v), want (none, context.Canceled)", len(response), err)
			}
			if ctx.checks < 2 {
				t.Fatalf("context checked %d times, want a check after the instance was acquired", ctx.checks)
			}
			// The unused instance is healthy, so it goes back to the pool instead of being lost.
			if got := engine.Stats(); got != (wasmengine.Stats{Live: 1, Idle: 1}) {
				t.Fatalf("after the canceled call Stats = %+v, want the instance pooled", got)
			}
			if _, err := engine.Call(context.Background(), request); err != nil {
				t.Fatalf("engine unusable after the canceled call: %v", err)
			}
		})
	}
}

func TestOutOfMemoryFailsCleanlyAndTheNextCallSucceeds(t *testing.T) {
	tests := []struct {
		name    string
		request func(t *testing.T) []byte
		want    string
	}{
		// The request itself does not fit: alloc returns 0 and nothing traps.
		{name: "request larger than memory", want: "alloc of", request: func(*testing.T) []byte {
			big := append([]byte(`{"op":"defaults","pad":"`), bytes.Repeat([]byte("x"), 6<<20)...)
			return append(big, `"}`...)
		}},
		// The request fits, but computing it does not: the guest aborts with a trap.
		{name: "computation larger than memory", want: "compute:", request: func(t *testing.T) []byte {
			return bigRequest(t, 8)
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// 64 pages = 4 MiB of linear memory.
			engine := newEngine(t, wasmengine.Options{MaxInstances: 1, MemoryLimitPages: 64})
			_, err := engine.Invoke(context.Background(), tt.request(t))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Invoke = %v, want an error containing %q", err, tt.want)
			}
			if live := engine.Stats().Live; live != 0 {
				t.Fatalf("failed instance kept: %d live", live)
			}
			if _, err := engine.Call(context.Background(), []byte(`{"op":"defaults"}`)); err != nil {
				t.Fatalf("engine unusable after an out-of-memory call: %v", err)
			}
		})
	}
}

func TestInstancesThatGrewPastTheRetainLimitAreNotPooled(t *testing.T) {
	// 32 pages = 2 MiB: the 2.5 MiB request below grows the instance past it.
	engine := newEngine(t, wasmengine.Options{MaxInstances: 1, RetainMemoryPages: 32})
	if _, err := engine.Call(context.Background(), []byte(`{"op":"defaults"}`)); err != nil {
		t.Fatalf("small call: %v", err)
	}
	if got := engine.Stats(); got != (wasmengine.Stats{Live: 1, Idle: 1}) {
		t.Fatalf("after a small call Stats = %+v, want one pooled instance", got)
	}
	if _, err := engine.Invoke(context.Background(), bigRequest(t, 8)); err != nil {
		t.Fatalf("large call: %v", err)
	}
	if got := engine.Stats(); got != (wasmengine.Stats{}) {
		t.Fatalf("after a large call Stats = %+v, want the grown instance discarded", got)
	}
}

func TestCloseDuringCallsLeavesNoCallerWaiting(t *testing.T) {
	ctx := context.Background()
	engine, err := wasmengine.New(ctx, loadWasm(t), wasmengine.Options{MaxInstances: 2})
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}
	request := bigRequest(t, 4)
	const callers = 6 // more than the pool: some are waiting for an instance when Close runs
	done := make(chan error, callers)
	for range callers {
		go func() {
			_, err := engine.Invoke(ctx, request)
			done <- err
		}()
	}
	time.Sleep(20 * time.Millisecond)
	if err := engine.Close(ctx); err != nil {
		t.Fatalf("close: %v", err)
	}
	timeout := time.After(30 * time.Second)
	for range callers {
		select {
		case <-done: // completed or failed: both are fine, waiting forever is not
		case <-timeout:
			t.Fatal("a call was still waiting 30 s after Close")
		}
	}
	if _, err := engine.Invoke(ctx, request); !errors.Is(err, wasmengine.ErrClosed) {
		t.Fatalf("Invoke after Close = %v, want ErrClosed", err)
	}
}

func TestCloseRejectsLaterCalls(t *testing.T) {
	ctx := context.Background()
	engine, err := wasmengine.New(ctx, loadWasm(t), wasmengine.Options{})
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}
	if err := engine.Close(ctx); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := engine.Close(ctx); err != nil {
		t.Fatalf("second close: %v", err)
	}
	if _, err := engine.Invoke(ctx, []byte(`{"op":"defaults"}`)); !errors.Is(err, wasmengine.ErrClosed) {
		t.Fatalf("Invoke after Close = %v, want ErrClosed", err)
	}
}

func TestNewRejectsAModuleWithoutTheABI(t *testing.T) {
	// The smallest valid module: magic and version only, no exports.
	empty := []byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00}
	if _, err := wasmengine.New(context.Background(), empty, wasmengine.Options{}); err == nil {
		t.Fatal("New accepted a module without alloc/compute/dealloc")
	}
}

func benchmarkCase(b *testing.B, name string, instances int) {
	engine := newEngine(b, wasmengine.Options{MaxInstances: instances})
	var request []byte
	for _, tc := range loadCases(b) {
		if tc.Name == name {
			request = []byte(tc.Request)
		}
	}
	if request == nil {
		b.Fatalf("no fixture %s", name)
	}
	ctx := context.Background()
	b.SetBytes(int64(len(request)))
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if _, err := engine.Invoke(ctx, request); err != nil {
				b.Error(err)
				return
			}
		}
	})
}

func BenchmarkIndicators1x(b *testing.B) {
	benchmarkCase(b, "indicators/synthetic-1x-seed42-all-modules", 1)
}

func BenchmarkIrsa3x(b *testing.B) { benchmarkCase(b, "irsa/synthetic-3x-seed11-phase-weights", 1) }

func BenchmarkIrsa3xPool4(b *testing.B) {
	benchmarkCase(b, "irsa/synthetic-3x-seed11-phase-weights", 4)
}

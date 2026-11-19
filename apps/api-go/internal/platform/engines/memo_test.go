package engines

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/tetratelabs/wazero"
)

// countingEngine answers "<request>!" and counts its calls; requests starting with "fail" fail.
type countingEngine struct {
	calls   atomic.Int64
	release chan struct{} // when set, every call waits for it
}

func (e *countingEngine) Call(_ context.Context, request []byte) (json.RawMessage, error) {
	e.calls.Add(1)
	if e.release != nil {
		<-e.release
	}
	if bytes.HasPrefix(request, []byte("fail")) {
		return nil, errors.New("engine failed")
	}
	return append(bytes.Clone(request), '!'), nil
}

func TestMemoAnswersARepeatedRequestOnce(t *testing.T) {
	t.Parallel()
	engine := &countingEngine{}
	m := NewMemo(engine)
	for range 3 {
		got, err := m.Call(context.Background(), []byte("a"))
		if err != nil || string(got) != "a!" {
			t.Fatalf("got %q, %v", got, err)
		}
		got[0] = 'X' // a caller's copy is its own
	}
	if _, err := m.Call(context.Background(), []byte("b")); err != nil {
		t.Fatal(err)
	}
	if n := engine.calls.Load(); n != 2 {
		t.Fatalf("engine ran %d times, want 2", n)
	}
}

func TestMemoNeverKeepsAFailure(t *testing.T) {
	t.Parallel()
	engine := &countingEngine{}
	m := NewMemo(engine)
	for range 2 {
		if _, err := m.Call(context.Background(), []byte("fail")); err == nil {
			t.Fatal("no error")
		}
	}
	if n := engine.calls.Load(); n != 2 {
		t.Fatalf("engine ran %d times, want 2", n)
	}
}

func TestMemoDropsTheLeastRecentlyUsed(t *testing.T) {
	t.Parallel()
	engine := &countingEngine{}
	m := NewMemo(engine)
	call := func(i int) {
		if _, err := m.Call(context.Background(), fmt.Appendf(nil, "r%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	for i := range memoEntries {
		call(i)
	}
	call(0)           // r0 is now the most recent
	call(memoEntries) // drops r1
	before := engine.calls.Load()
	call(0)
	if engine.calls.Load() != before {
		t.Fatal("r0 was dropped")
	}
	call(1)
	if engine.calls.Load() != before+1 {
		t.Fatal("r1 was kept")
	}
	if m.order.Len() != memoEntries || len(m.entries) != memoEntries {
		t.Fatalf("%d entries", m.order.Len())
	}
}

func TestMemoSkipsHugeAnswers(t *testing.T) {
	t.Parallel()
	engine := &countingEngine{}
	m := NewMemo(engine)
	huge := bytes.Repeat([]byte("x"), memoMaxValue)
	for range 2 {
		if _, err := m.Call(context.Background(), huge); err != nil {
			t.Fatal(err)
		}
	}
	if n := engine.calls.Load(); n != 2 || m.bytes != 0 {
		t.Fatalf("engine ran %d times, %d bytes kept", n, m.bytes)
	}
}

func TestMemoRunsConcurrentEqualRequestsOnce(t *testing.T) {
	t.Parallel()
	engine := &countingEngine{release: make(chan struct{})}
	m := NewMemo(engine)
	var wg sync.WaitGroup
	answers := make([]string, 8)
	for i := range answers {
		wg.Go(func() {
			got, err := m.Call(context.Background(), []byte("same"))
			if err != nil {
				t.Error(err)
			}
			answers[i] = string(got)
		})
	}
	for engine.calls.Load() == 0 {
		// wait until the first caller is inside the engine
	}
	for {
		m.mu.Lock()
		waiting := len(m.inFlight)
		m.mu.Unlock()
		if waiting == 1 {
			break
		}
	}
	close(engine.release)
	wg.Wait()
	if n := engine.calls.Load(); n != 1 {
		t.Fatalf("engine ran %d times", n)
	}
	for _, a := range answers {
		if a != "same!" {
			t.Fatalf("answers %q", answers)
		}
	}
}

func TestMemoWaiterStopsWithItsContext(t *testing.T) {
	t.Parallel()
	engine := &countingEngine{release: make(chan struct{})}
	m := NewMemo(engine)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = m.Call(context.Background(), []byte("slow"))
	}()
	for engine.calls.Load() == 0 {
		// wait until the first caller is inside the engine
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := m.Call(ctx, []byte("slow")); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	close(engine.release)
	<-done
}

// TestIndicatorsEngineIsPure guards Memo's premise: the indicators module reads nothing but its
// request. A new import (a clock, a file) would make memoized answers stale; review Memo first.
func TestIndicatorsEngineIsPure(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	r := wazero.NewRuntime(ctx)
	defer func() { _ = r.Close(ctx) }()
	compiled, err := r.CompileModule(ctx, indicatorsWasm)
	if err != nil {
		t.Fatal(err)
	}
	var imports []string
	for _, f := range compiled.ImportedFunctions() {
		module, name, _ := f.Import()
		imports = append(imports, module+"."+name)
	}
	slices.Sort(imports)
	want := []string{
		"wasi_snapshot_preview1.environ_get", "wasi_snapshot_preview1.environ_sizes_get",
		"wasi_snapshot_preview1.fd_write", "wasi_snapshot_preview1.proc_exit", "wasi_snapshot_preview1.random_get",
	}
	if !slices.Equal(imports, want) {
		t.Fatalf("indicators engine imports %v, want %v", imports, want)
	}
}

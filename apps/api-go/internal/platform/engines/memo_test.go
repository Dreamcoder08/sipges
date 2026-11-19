package engines

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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

// panickingEngine panics on its first call, after waiting for release, then answers normally.
type panickingEngine struct {
	calls   atomic.Int64
	release chan struct{}
}

func (e *panickingEngine) Call(_ context.Context, request []byte) (json.RawMessage, error) {
	if e.calls.Add(1) == 1 {
		<-e.release
		panic("engine panicked")
	}
	return append(bytes.Clone(request), '!'), nil
}

func TestMemoSurvivesAPanickingEngine(t *testing.T) {
	t.Parallel()
	engine := &panickingEngine{release: make(chan struct{})}
	m := NewMemo(engine)
	panicked := make(chan any, 1)
	go func() {
		defer func() { panicked <- recover() }()
		_, _ = m.Call(context.Background(), []byte("p"))
	}()
	for engine.calls.Load() == 0 {
		// wait until the first caller is inside the engine
	}
	waiter := make(chan error, 1)
	go func() {
		_, err := m.Call(context.Background(), []byte("p"))
		waiter <- err
	}()
	for {
		m.mu.Lock()
		joined := len(m.inFlight) == 1 && m.inFlight[sha256.Sum256([]byte("p"))].waiters == 1
		m.mu.Unlock()
		if joined {
			break
		}
	}
	close(engine.release)
	if r := <-panicked; r == nil {
		t.Fatal("the panic did not reach the first caller")
	}
	// The waiter is woken with an error, not left until its context ends.
	select {
	case err := <-waiter:
		if !errors.Is(err, ErrEnginePanicked) {
			t.Fatalf("waiter: %v, want ErrEnginePanicked", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter still blocked after the engine panicked")
	}
	m.mu.Lock()
	left := len(m.inFlight)
	m.mu.Unlock()
	if left != 0 {
		t.Fatalf("%d in-flight entries left", left)
	}
	if got, err := m.Call(context.Background(), []byte("p")); err != nil || string(got) != "p!" {
		t.Fatalf("later call: %q, %v", got, err)
	}
}

// ctxEngine waits for release or for its caller's context, then answers or returns ctx's error.
type ctxEngine struct {
	calls   atomic.Int64
	release chan struct{}
}

func (e *ctxEngine) Call(ctx context.Context, request []byte) (json.RawMessage, error) {
	e.calls.Add(1)
	select {
	case <-e.release:
		return append(bytes.Clone(request), '!'), nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func waiters(m *Memo, request string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.inFlight[sha256.Sum256([]byte(request))]; ok {
		return c.waiters
	}
	return -1
}

func TestMemoWaiterTakesOverWhenTheFirstCallerGivesUp(t *testing.T) {
	t.Parallel()
	engine := &ctxEngine{release: make(chan struct{})}
	m := NewMemo(engine)
	leaderCtx, disconnect := context.WithCancel(context.Background())
	leader := make(chan error, 1)
	go func() {
		_, err := m.Call(leaderCtx, []byte("q"))
		leader <- err
	}()
	for engine.calls.Load() == 0 {
		// wait until the first caller is inside the engine
	}
	const n = 4
	answers := make(chan string, n)
	for range n {
		go func() {
			got, err := m.Call(context.Background(), []byte("q"))
			if err != nil {
				t.Error(err)
			}
			answers <- string(got)
		}()
	}
	for waiters(m, "q") != n {
		// wait until every waiter joined
	}
	disconnect() // the client of the first caller went away
	if err := <-leader; !errors.Is(err, context.Canceled) {
		t.Fatalf("first caller: %v", err)
	}
	for engine.calls.Load() < 2 {
		// one waiter is the new computer
	}
	close(engine.release)
	for range n {
		if got := <-answers; got != "q!" {
			t.Fatalf("answer %q", got)
		}
	}
	if c := engine.calls.Load(); c != 2 {
		t.Fatalf("engine ran %d times, want 2 (the first caller and one waiter)", c)
	}
	if got, err := m.Call(context.Background(), []byte("q")); err != nil || string(got) != "q!" || engine.calls.Load() != 2 {
		t.Fatalf("not memoized after the takeover: %q, %v, %d calls", got, err, engine.calls.Load())
	}
}

func TestMemoWaitersShareAnEngineError(t *testing.T) {
	t.Parallel()
	engine := &countingEngine{release: make(chan struct{})}
	m := NewMemo(engine)
	const n = 4
	errs := make(chan error, n+1)
	for range n + 1 {
		go func() {
			_, err := m.Call(context.Background(), []byte("fail"))
			errs <- err
		}()
	}
	for waiters(m, "fail") != n {
		// wait until one computes and the others wait
	}
	close(engine.release)
	for range n + 1 {
		if err := <-errs; err == nil || err.Error() != "engine failed" {
			t.Fatalf("err = %v", err)
		}
	}
	if c := engine.calls.Load(); c != 1 {
		t.Fatalf("engine ran %d times for one failing request, want 1", c)
	}
}

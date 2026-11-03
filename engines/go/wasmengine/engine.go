// Package wasmengine runs a SIPGES Rust engine compiled to WebAssembly (wasm32-wasip1) inside the
// Go process with wazero (pure Go, no cgo).
//
// The module exports the JSON ABI described in engines/README.md: alloc(len) -> ptr,
// compute(ptr, len) -> (out_ptr << 32 | out_len) and dealloc(ptr, len). An Engine compiles the
// module once and keeps a bounded pool of instances, because a single instance is not safe for
// concurrent calls. An instance that traps or is interrupted is discarded, never reused.
package wasmengine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// ErrClosed is returned by calls on an Engine after Close.
var ErrClosed = errors.New("wasmengine: engine is closed")

// DefaultMemoryLimitPages caps each instance's linear memory at 128 MiB (64 KiB pages).
const DefaultMemoryLimitPages = 2048

// DefaultRetainMemoryPages is the largest linear memory (16 MiB) an idle instance may keep.
const DefaultRetainMemoryPages = 256

const pageSize = 64 << 10

// Options tunes an Engine. The zero value is valid.
type Options struct {
	// MaxInstances bounds concurrent calls (default 4). Callers beyond it wait for a free instance.
	MaxInstances int
	// MemoryLimitPages caps each instance's linear memory (default DefaultMemoryLimitPages).
	MemoryLimitPages uint32
	// Interruptible stops a call in flight when its context is done. It makes wazero insert
	// checks into the compiled code, which measured 5.3x slower on the indicators engine
	// (2.28 → 12.09 ms per 1x request), so it is off by default: the context is then checked
	// before each call, and a call runs to completion (engine calls are bounded by the input).
	Interruptible bool
	// RetainMemoryPages is the largest linear memory an instance may keep when it goes back to
	// the pool (default DefaultRetainMemoryPages). Linear memory never shrinks, so an instance
	// that served a large request is discarded instead of holding its peak memory while idle.
	RetainMemoryPages uint32
}

// Stats reports the pool: Live instances exist (idle or busy), Idle ones wait in the pool.
type Stats struct {
	Live int
	Idle int
}

// Error is an engine-reported failure: {"ok":false,"error":{"code","message"}}.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return fmt.Sprintf("engine error %s: %s", e.Code, e.Message) }

// Engine is safe for concurrent use.
type Engine struct {
	retain   uint64 // bytes of linear memory an idle instance may keep
	runtime  wazero.Runtime
	compiled wazero.CompiledModule
	idle     chan *instance
	slots    chan struct{} // one token per live instance
	mu       sync.RWMutex  // guards closed
	closed   bool
}

type instance struct {
	module   api.Module
	memory   api.Memory
	alloc    api.Function
	dealloc  api.Function
	computeF api.Function
}

// New compiles wasm and prepares the instance pool. Instances are created lazily.
func New(ctx context.Context, wasm []byte, opts Options) (*Engine, error) {
	if opts.MaxInstances <= 0 {
		opts.MaxInstances = 4
	}
	if opts.MemoryLimitPages == 0 {
		opts.MemoryLimitPages = DefaultMemoryLimitPages
	}
	if opts.RetainMemoryPages == 0 {
		opts.RetainMemoryPages = DefaultRetainMemoryPages
	}
	config := wazero.NewRuntimeConfig().
		WithCloseOnContextDone(opts.Interruptible).
		WithMemoryLimitPages(opts.MemoryLimitPages)
	runtime := wazero.NewRuntimeWithConfig(ctx, config)
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, runtime); err != nil {
		return nil, errors.Join(fmt.Errorf("wasmengine: instantiate WASI: %w", err), runtime.Close(ctx))
	}
	compiled, err := runtime.CompileModule(ctx, wasm)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("wasmengine: compile module: %w", err), runtime.Close(ctx))
	}
	for _, name := range []string{"alloc", "dealloc", "compute"} {
		if _, ok := compiled.ExportedFunctions()[name]; !ok {
			return nil, errors.Join(fmt.Errorf("wasmengine: module does not export %q", name), runtime.Close(ctx))
		}
	}
	return &Engine{
		retain:   uint64(opts.RetainMemoryPages) * pageSize,
		runtime:  runtime,
		compiled: compiled,
		idle:     make(chan *instance, opts.MaxInstances),
		slots:    make(chan struct{}, opts.MaxInstances),
	}, nil
}

// Invoke sends one JSON request and returns the raw JSON response envelope, byte for byte as the
// engine wrote it. Engine-level failures ({"ok":false,...}) are returned as response bytes, not
// as an error; use Call to decode them.
func (e *Engine) Invoke(ctx context.Context, request []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("wasmengine: %w", err)
	}
	in, err := e.acquire(ctx)
	if err != nil {
		return nil, err
	}
	// select picks randomly among ready cases, so a caller whose context ended while it waited
	// may still have been handed an instance: do not start the call then.
	if err := ctx.Err(); err != nil {
		e.release(ctx, in, true)
		return nil, fmt.Errorf("wasmengine: %w", err)
	}
	response, err := in.invoke(ctx, request)
	e.release(ctx, in, err == nil)
	return response, err
}

// Call sends one JSON request and returns the "value" of a successful response, or an *Error
// when the engine rejected the request.
func (e *Engine) Call(ctx context.Context, request []byte) (json.RawMessage, error) {
	raw, err := e.Invoke(ctx, request)
	if err != nil {
		return nil, err
	}
	var envelope struct {
		OK    bool            `json:"ok"`
		Value json.RawMessage `json:"value"`
		Error *Error          `json:"error"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("wasmengine: decode response: %w", err)
	}
	if !envelope.OK {
		if envelope.Error == nil {
			return nil, errors.New("wasmengine: response has ok=false without an error")
		}
		return nil, envelope.Error
	}
	return envelope.Value, nil
}

// Stats returns a snapshot of the instance pool.
func (e *Engine) Stats() Stats {
	return Stats{Live: len(e.slots), Idle: len(e.idle)}
}

// Close releases the runtime and every instance; later calls get ErrClosed. A call in flight
// either completes or fails (an interruptible one is stopped); none is left waiting.
func (e *Engine) Close(ctx context.Context) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return nil
	}
	e.closed = true
	if err := e.runtime.Close(ctx); err != nil {
		return fmt.Errorf("wasmengine: close runtime: %w", err)
	}
	return nil
}

func (e *Engine) isClosed() bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.closed
}

func (e *Engine) acquire(ctx context.Context) (*instance, error) {
	if e.isClosed() {
		return nil, ErrClosed
	}
	select {
	case in := <-e.idle:
		return in, nil
	default:
	}
	select {
	case in := <-e.idle:
		return in, nil
	case e.slots <- struct{}{}:
		in, err := e.instantiate(ctx)
		if err != nil {
			<-e.slots
			return nil, err
		}
		return in, nil
	case <-ctx.Done():
		return nil, fmt.Errorf("wasmengine: wait for an instance: %w", ctx.Err())
	}
}

// release returns a healthy instance to the pool, or discards it and frees its slot.
func (e *Engine) release(ctx context.Context, in *instance, healthy bool) {
	if healthy && !e.isClosed() && uint64(in.memory.Size()) <= e.retain {
		e.idle <- in // never blocks: at most cap(slots) instances exist
		return
	}
	_ = in.module.Close(context.WithoutCancel(ctx)) // already closed after a trap or interruption
	<-e.slots
}

func (e *Engine) instantiate(ctx context.Context) (*instance, error) {
	// Anonymous instances so one compiled module can be instantiated many times. A reactor module
	// exposes _initialize (when present) instead of _start.
	config := wazero.NewModuleConfig().WithName("").WithStartFunctions("_initialize")
	module, err := e.runtime.InstantiateModule(ctx, e.compiled, config)
	if err != nil {
		return nil, fmt.Errorf("wasmengine: instantiate module: %w", err)
	}
	in := &instance{
		module:   module,
		memory:   module.Memory(),
		alloc:    module.ExportedFunction("alloc"),
		dealloc:  module.ExportedFunction("dealloc"),
		computeF: module.ExportedFunction("compute"),
	}
	if in.memory == nil || in.alloc == nil || in.dealloc == nil || in.computeF == nil {
		return nil, errors.Join(errors.New("wasmengine: module lacks memory or ABI exports"), module.Close(ctx))
	}
	return in, nil
}

func (in *instance) invoke(ctx context.Context, request []byte) ([]byte, error) {
	size := uint64(len(request))
	if size > uint64(^uint32(0)) {
		return nil, fmt.Errorf("wasmengine: request of %d bytes exceeds 32-bit memory", size)
	}
	results, err := in.alloc.Call(ctx, size)
	if err != nil {
		return nil, fmt.Errorf("wasmengine: alloc: %w", err)
	}
	ptr := results[0]
	if ptr == 0 && size > 0 {
		return nil, fmt.Errorf("wasmengine: alloc of %d bytes failed", size)
	}
	if !in.memory.Write(uint32(ptr), request) {
		return nil, fmt.Errorf("wasmengine: write request: offset %d out of range", ptr)
	}
	results, err = in.computeF.Call(ctx, ptr, size)
	if err != nil {
		return nil, fmt.Errorf("wasmengine: compute: %w", err)
	}
	if _, err := in.dealloc.Call(ctx, ptr, size); err != nil {
		return nil, fmt.Errorf("wasmengine: dealloc request: %w", err)
	}
	outPtr, outLen := uint32(results[0]>>32), uint32(results[0])
	view, ok := in.memory.Read(outPtr, outLen)
	if !ok {
		return nil, fmt.Errorf("wasmengine: read response: %d bytes at %d out of range", outLen, outPtr)
	}
	response := make([]byte, len(view)) // the view aliases linear memory; copy before freeing
	copy(response, view)
	if _, err := in.dealloc.Call(ctx, uint64(outPtr), uint64(outLen)); err != nil {
		return nil, fmt.Errorf("wasmengine: dealloc response: %w", err)
	}
	return response, nil
}

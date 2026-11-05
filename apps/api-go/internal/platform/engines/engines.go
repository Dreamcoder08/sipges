// Package engines holds the SIPGES Rust engines the Go API calls (ADR 0032): the indicators and
// analytics WebAssembly modules, embedded in the binary and run with wazero through
// engines/go/wasmengine. The .wasm files are built by engines/build-wasm.sh, reproducibly, and
// CI fails when they differ from a fresh build of engines/ (rust.yml).
package engines

import (
	"context"
	_ "embed"
	"fmt"
	"sync"

	"github.com/Dreamcoder08/sipges/engines/go/wasmengine"
)

//go:embed wasm/indicators.wasm
var indicatorsWasm []byte

//go:embed wasm/analytics.wasm
var analyticsWasm []byte

// Set is the two compiled engines. Each is safe for concurrent use.
type Set struct {
	// Indicators runs the ops of sipges-indicators-wasm (indicators, irsa, irsa_config_patch,
	// select_band, defaults).
	Indicators *wasmengine.Engine
	// Analytics runs the ops of sipges-analytics-wasm (situational, strategic, consensus,
	// candidate_links, integrated).
	Analytics *wasmengine.Engine
}

// analyticsRetainPages keeps 64 MiB of linear memory in an idle analytics instance. A call over
// 5,000 records grows an instance to about 33 MiB, above wasmengine's 16 MiB default, so the
// default discarded it after almost every call and each request paid a new instance.
const analyticsRetainPages = 1024

var (
	sharedOnce sync.Once
	shared     *Set
	sharedErr  error
)

// Shared compiles both modules once per process and returns the same Set on every call; it is
// never closed (it lives as long as the process). The first call pays the compilation, so
// cmd/api calls it at start.
func Shared(ctx context.Context) (*Set, error) {
	sharedOnce.Do(func() {
		shared, sharedErr = open(context.WithoutCancel(ctx))
	})
	return shared, sharedErr
}

func open(ctx context.Context) (*Set, error) {
	indicators, err := wasmengine.New(ctx, indicatorsWasm, wasmengine.Options{})
	if err != nil {
		return nil, fmt.Errorf("compile the indicators engine: %w", err)
	}
	analytics, err := wasmengine.New(ctx, analyticsWasm, wasmengine.Options{RetainMemoryPages: analyticsRetainPages})
	if err != nil {
		_ = indicators.Close(ctx)
		return nil, fmt.Errorf("compile the analytics engine: %w", err)
	}
	return &Set{Indicators: indicators, Analytics: analytics}, nil
}

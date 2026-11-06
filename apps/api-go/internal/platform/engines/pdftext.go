package engines

import (
	"context"
	_ "embed"
	"fmt"
	"runtime"
	"sync"

	"github.com/Dreamcoder08/sipges/engines/go/wasmengine"
)

//go:embed wasm/pdf-text.wasm
var pdfTextWasm []byte

// pdfjsBytecode is pdf.js compiled by pdf-text.wasm itself (engines/go/cmd/pdf-bytecode).
//
//go:embed wasm/pdfjs.qbc
var pdfjsBytecode []byte

// pdfMemoryPages caps one read at 240 MiB of linear memory, above QuickJS's own 224 MiB limit.
const pdfMemoryPages = 3840

// PDFWorkers is the number of concurrent PDF reads, the size of the TypeScript worker pool.
func PDFWorkers() int {
	return max(1, min(2, runtime.GOMAXPROCS(0)-1))
}

var (
	pdfOnce   sync.Once
	pdfEngine *wasmengine.Engine
	pdfErr    error
)

// PDFText compiles the PDF reader once, on the first PDF: it costs about 3 s on a quarter vCPU,
// which a cold start must not pay. One page of retained memory discards every instance after its
// call, so no state of one document reaches the next.
func PDFText(ctx context.Context) (*wasmengine.Engine, []byte, error) {
	pdfOnce.Do(func() {
		pdfEngine, pdfErr = wasmengine.New(context.WithoutCancel(ctx), pdfTextWasm, wasmengine.Options{
			MaxInstances:      PDFWorkers(),
			MemoryLimitPages:  pdfMemoryPages,
			RetainMemoryPages: 1,
			Clock:             true,
		})
		if pdfErr != nil {
			pdfErr = fmt.Errorf("compile the PDF reader: %w", pdfErr)
		}
	})
	return pdfEngine, pdfjsBytecode, pdfErr
}

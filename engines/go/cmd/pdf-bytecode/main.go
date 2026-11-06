// Command pdf-bytecode compiles the PDF reader's JavaScript to QuickJS bytecode with the module
// itself, because that bytecode only loads in the QuickJS build that wrote it.
//
//	pdf-bytecode <pdf-text.wasm> <js directory> <out.qbc>
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/Dreamcoder08/sipges/engines/go/wasmengine"
)

// sources are concatenated in this order into one script.
var sources = []string{"shim.js", "pdfjs.bundle.js", "driver.js"}

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: pdf-bytecode <pdf-text.wasm> <js directory> <out.qbc>")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2], os.Args[3]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(wasmPath, jsDir, out string) error {
	ctx := context.Background()
	wasm, err := os.ReadFile(wasmPath)
	if err != nil {
		return err
	}
	engine, err := wasmengine.New(ctx, wasm, wasmengine.Options{MemoryLimitPages: 3840})
	if err != nil {
		return err
	}
	defer func() { _ = engine.Close(ctx) }()
	request := []byte{'C'}
	for _, name := range sources {
		part, err := os.ReadFile(filepath.Join(jsDir, name))
		if err != nil {
			return err
		}
		request = append(append(request, part...), '\n')
	}
	response, err := engine.Invoke(ctx, request)
	if err != nil {
		return err
	}
	if len(response) < 2 || response[0] != 1 {
		return errors.New("the JavaScript does not compile")
	}
	return os.WriteFile(out, response[1:], 0o644)
}

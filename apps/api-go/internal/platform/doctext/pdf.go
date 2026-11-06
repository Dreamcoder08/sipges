package doctext

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/engines"
)

// ErrPDFUnreadable is any PDF that could not be read, without parser details.
var ErrPDFUnreadable = errors.New("doctext: unreadable PDF")

const (
	// defaultPDFBudget bounds any read, queue included, as the TypeScript pool does.
	defaultPDFBudget = 30 * time.Second
	// pdfGrace is how long past its budget a call may run before the caller stops waiting. The
	// guest stops itself; this covers time spent in a QuickJS builtin, which it cannot interrupt.
	pdfGrace = 2 * time.Second
)

// pdfSlots holds a read from its queue to its real end, even after a caller stopped waiting.
var pdfSlots = make(chan struct{}, engines.PDFWorkers())

// ReadPDF returns the page texts of an untrusted PDF as pdf.js gives them (ADR 0033), or tooMany
// before reading any page beyond maxPages. The time waiting for a slot counts against ctx.
func ReadPDF(ctx context.Context, data []byte, maxPages int) (pages []string, tooMany bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, defaultPDFBudget)
	defer cancel()
	if ctx.Err() != nil {
		return nil, false, ErrPDFUnreadable
	}
	engine, bytecode, err := engines.PDFText(ctx)
	if err != nil {
		return nil, false, errors.Join(ErrPDFUnreadable, err)
	}
	select {
	case pdfSlots <- struct{}{}:
	case <-ctx.Done():
		return nil, false, ErrPDFUnreadable
	}
	deadline, _ := ctx.Deadline()
	budget := time.Until(deadline)
	if budget < time.Millisecond {
		<-pdfSlots
		return nil, false, ErrPDFUnreadable
	}
	request := pdfRequest(bytecode, data, maxPages, budget)
	answer := make(chan pdfAnswer, 1)
	go func() {
		defer func() { <-pdfSlots }()
		defer func() {
			if recover() != nil {
				answer <- pdfAnswer{err: ErrPDFUnreadable}
			}
		}()
		callCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), budget+pdfGrace)
		defer cancel()
		response, err := engine.Invoke(callCtx, request)
		answer <- pdfAnswer{response: response, err: err}
	}()
	wait := time.NewTimer(budget + pdfGrace)
	defer wait.Stop()
	select {
	case got := <-answer:
		if got.err != nil {
			return nil, false, ErrPDFUnreadable
		}
		return parsePDFResponse(got.response)
	case <-wait.C:
		return nil, false, ErrPDFUnreadable
	}
}

type pdfAnswer struct {
	response []byte
	err      error
}

// pdfRequest is the binary request of engines/crates/pdf-text-wasm.
func pdfRequest(bytecode, data []byte, maxPages int, budget time.Duration) []byte {
	request := make([]byte, 13, 13+len(bytecode)+len(data))
	request[0] = 'R'
	// All three fit: a page limit of the domain, at most 30 s, and the embedded bytecode's size.
	binary.LittleEndian.PutUint32(request[1:], uint32(maxPages))              //nolint:gosec // see above
	binary.LittleEndian.PutUint32(request[5:], uint32(budget.Milliseconds())) //nolint:gosec // see above
	binary.LittleEndian.PutUint32(request[9:], uint32(len(bytecode)))         //nolint:gosec // see above
	return append(append(request, bytecode...), data...)
}

func parsePDFResponse(response []byte) ([]string, bool, error) {
	if len(response) < 2 || response[0] != 1 {
		return nil, false, ErrPDFUnreadable
	}
	var result struct {
		Kind  string   `json:"kind"`
		Pages []string `json:"pages"`
	}
	if err := json.Unmarshal(response[1:], &result); err != nil {
		return nil, false, fmt.Errorf("%w: %w", ErrPDFUnreadable, err)
	}
	switch result.Kind {
	case "pages":
		return result.Pages, false, nil
	case "too_many_pages":
		return nil, true, nil
	}
	return nil, false, ErrPDFUnreadable
}

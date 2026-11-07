package fileinventory

import (
	"errors"
	"io"
)

// The limits of one file, so a crafted one costs a line in the report and not the whole run. A
// real file is far below these: a million rows of twenty columns is about a gibibyte of XML, no
// single cell or row comes near a run, and Excel stops at this many columns.
const (
	maxColumns = 16384
	maxSheets  = 1024
	// Excel stops at 31 characters for a sheet name; this also covers part names.
	maxNameBytes = 1 << 10
	// The header cells one workbook may keep, across its sheets.
	maxKeptCells = 1 << 16
)

// Variables so a test need not build a file of this size.
var (
	unpackLimit = int64(8 << 30)
	runLimit    = 32 << 20
)

var (
	errTooLarge = errors.New("larger than the limit")
	errMarkup   = errors.New("comment or CDATA in a spreadsheet part")
)

type boundedReader struct {
	in        io.Reader
	remaining *int64
	stop      byte
	run       int
	maxRun    int
	last      byte
	inPI      bool
}

// bounded fails with errTooLarge once the budget, which the parts of one file share, is spent, or,
// when maxRun is set, after that many bytes without a stop byte: the parsers above it hold one
// such run in memory at a time. A comment or CDATA section would hide a run behind stop bytes
// inside it, so with maxRun set their opening <! fails the read. A processing instruction opens
// every part, so it may stay, but a stop byte inside one does not end the run.
func bounded(in io.Reader, budget *int64, stop byte, maxRun int) io.Reader {
	return &boundedReader{in: in, remaining: budget, stop: stop, maxRun: maxRun}
}

func (b *boundedReader) Read(p []byte) (int, error) {
	n, err := b.in.Read(p)
	*b.remaining -= int64(n)
	if *b.remaining < 0 {
		return 0, errTooLarge
	}
	if b.maxRun > 0 {
		for _, c := range p[:n] {
			switch {
			case b.last == '<' && c == '!':
				return 0, errMarkup
			case b.last == '<' && c == '?':
				b.inPI = true
			case b.last == '?' && c == '>':
				b.inPI = false
			}
			b.last = c
			if c == b.stop && !b.inPI {
				b.run = 0
			} else if b.run++; b.run > b.maxRun {
				return 0, errTooLarge
			}
		}
	}
	return n, err
}

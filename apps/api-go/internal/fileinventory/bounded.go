package fileinventory

import (
	"errors"
	"io"
)

// The limits of one file, so a crafted one costs a line in the report and not the whole run. A
// real part is far below these: a million rows of twenty columns is about a gibibyte of XML, and
// no single cell or row comes near a run.
const (
	maxPartBytes = 8 << 30
	maxRunBytes  = 32 << 20
)

var errTooLarge = errors.New("larger than the limit")

type boundedReader struct {
	in        io.Reader
	remaining int64
	stop      byte
	run       int
	maxRun    int
}

// bounded fails with errTooLarge after total bytes, or, when maxRun is set, after that many bytes
// without a stop byte: the parsers above it hold one such run in memory at a time.
func bounded(in io.Reader, total int64, stop byte, maxRun int) io.Reader {
	return &boundedReader{in: in, remaining: total, stop: stop, maxRun: maxRun}
}

func (b *boundedReader) Read(p []byte) (int, error) {
	n, err := b.in.Read(p)
	b.remaining -= int64(n)
	if b.remaining < 0 {
		return 0, errTooLarge
	}
	if b.maxRun > 0 {
		for _, c := range p[:n] {
			if c == b.stop {
				b.run = 0
			} else if b.run++; b.run > b.maxRun {
				return 0, errTooLarge
			}
		}
	}
	return n, err
}

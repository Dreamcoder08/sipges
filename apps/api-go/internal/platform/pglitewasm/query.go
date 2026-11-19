package pglitewasm

import (
	"context"
	"encoding/binary"
	"errors"
)

// Result is the outcome of a simple query: text-format rows, or the SQL error
// PostgreSQL reported (its message, as a string).
type Result struct {
	Columns []string
	Rows    [][]string
	Error   string
}

// SimpleQuery sends one Query ('Q') message and decodes the reply.
func (b *Backend) SimpleQuery(ctx context.Context, sql string) (*Result, error) {
	return runSimple(ctx, b, sql)
}

func runSimple(ctx context.Context, ex exchanger, sql string) (*Result, error) {
	out, err := ex.Exchange(ctx, frontendMessage('Q', append([]byte(sql), 0)))
	if err != nil {
		return nil, err
	}
	return decodeSimple(out)
}

var errTruncated = errors.New("pglitewasm: truncated backend message")

func decodeSimple(out []byte) (*Result, error) {
	r := &Result{}
	ready := false
	for len(out) > 0 {
		if len(out) < 5 {
			return nil, errTruncated
		}
		typ := out[0]
		n := int(binary.BigEndian.Uint32(out[1:5]))
		if n < 4 || len(out) < 1+n {
			return nil, errTruncated
		}
		body := out[5 : 1+n]
		out = out[1+n:]
		var err error
		switch typ {
		case 'T':
			err = r.decodeRowDescription(body)
		case 'D':
			err = r.decodeDataRow(body)
		case 'E':
			r.decodeError(body)
		case 'Z':
			ready = true
		}
		if err != nil {
			return nil, err
		}
	}
	if !ready {
		return r, errors.New("pglitewasm: no ReadyForQuery in reply")
	}
	return r, nil
}

func (r *Result) decodeRowDescription(body []byte) error {
	if len(body) < 2 {
		return errTruncated
	}
	cols := int(binary.BigEndian.Uint16(body))
	body = body[2:]
	for range cols {
		i := indexZero(body)
		if len(body) < i+1+18 {
			return errTruncated
		}
		r.Columns = append(r.Columns, string(body[:i]))
		body = body[i+1+18:]
	}
	return nil
}

func (r *Result) decodeDataRow(body []byte) error {
	if len(body) < 2 {
		return errTruncated
	}
	cols := int(binary.BigEndian.Uint16(body))
	body = body[2:]
	row := make([]string, cols)
	for c := range cols {
		if len(body) < 4 {
			return errTruncated
		}
		ln := binary.BigEndian.Uint32(body)
		body = body[4:]
		if ln == 0xffffffff { // NULL
			continue
		}
		if uint64(ln) > uint64(len(body)) {
			return errTruncated
		}
		row[c] = string(body[:ln])
		body = body[ln:]
	}
	r.Rows = append(r.Rows, row)
	return nil
}

func (r *Result) decodeError(body []byte) {
	for len(body) > 1 {
		field := body[0]
		i := indexZero(body[1:])
		if field == 'M' {
			r.Error = string(body[1 : 1+i])
		}
		if 2+i > len(body) {
			return
		}
		body = body[2+i:]
	}
}

func indexZero(b []byte) int {
	for i, c := range b {
		if c == 0 {
			return i
		}
	}
	return len(b)
}

package fileinventory

import (
	"bufio"
	"bytes"
	"encoding/csv"
	"errors"
	"io"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

// The sample that decides a file's encoding and delimiter.
const (
	sampleBytes = 64 << 10
	sampleLines = 20
)

var errNotText = errors.New("not text")

// recordLimiter fails on one record that csv.Reader could not hold cheaply: too many bytes, which
// it keeps in one piece, or too many fields, which it allocates one by one. It follows the quotes
// the way the reader does with LazyQuotes: only a quote that opens a field starts a quoted run, an
// inch mark in a description is just a character, and a quoted field ends only at a quote right
// before a delimiter or a line end.
type recordLimiter struct {
	in        io.Reader
	comma     byte
	started   bool // inside a field, past its first byte
	quoted    bool
	closing   bool // inside a quoted field, just past a quote
	closingCR bool // and past one return after it
	run       int
	fields    int
}

func (l *recordLimiter) Read(p []byte) (int, error) {
	n, err := l.in.Read(p)
	for _, c := range p[:n] {
		l.step(c)
		if l.run > runLimit || l.fields > maxColumns {
			return 0, errTooLarge
		}
	}
	return n, err
}

func (l *recordLimiter) step(c byte) {
	l.run++
	if l.closing {
		// Only one return, directly before the line feed, belongs to the line end.
		if c == '\r' && !l.closingCR {
			l.closingCR = true
			return
		}
		afterCR := l.closingCR
		l.closing, l.closingCR = false, false
		switch {
		case c == '\n', c == l.comma && !afterCR:
			l.quoted = false
		case c == '"' && !afterCR: // a doubled quote is a literal one
			return
		default:
			l.closing = c == '"'
			return
		}
	}
	switch {
	case l.quoted:
		l.closing = c == '"'
	case c == '"' && !l.started:
		l.quoted, l.started = true, true
	case c == l.comma:
		l.fields++
		l.started = false
	case c == '\n':
		l.run, l.fields = 0, 0
		l.started = false
	default:
		l.started = true
	}
}

// decoderFor names the text encoding and returns how to read it as UTF-8. Excel's "CSV" in a
// Spanish locale is Windows-1252 with semicolons, and its "Unicode text" is UTF-16 with tabs.
func decoderFor(sample []byte) (string, transform.Transformer, error) {
	switch {
	case bytes.HasPrefix(sample, []byte{0xEF, 0xBB, 0xBF}):
		return "utf-8", unicode.UTF8BOM.NewDecoder(), nil
	case bytes.HasPrefix(sample, []byte{0xFF, 0xFE}), bytes.HasPrefix(sample, []byte{0xFE, 0xFF}):
		return "utf-16", unicode.UTF16(unicode.BigEndian, unicode.UseBOM).NewDecoder(), nil
	case bytes.IndexByte(sample, 0) >= 0:
		return "", nil, errNotText
	}
	// The sample may end in the middle of a character.
	trimmed := sample
	for range utf8.UTFMax {
		if len(trimmed) == 0 || utf8.Valid(trimmed) {
			break
		}
		trimmed = trimmed[:len(trimmed)-1]
	}
	if utf8.Valid(trimmed) {
		return "utf-8", transform.Nop, nil
	}
	return "windows-1252", charmap.Windows1252.NewDecoder(), nil
}

// delimiterOf picks the candidate seen most often outside quotes in the first lines.
func delimiterOf(text string) rune {
	counts := map[rune]int{}
	quoted, lines := false, 0
	for _, r := range text {
		switch {
		case r == '"':
			quoted = !quoted
		case quoted:
		case r == '\n':
			if lines++; lines == sampleLines {
				return busiest(counts)
			}
		case strings.ContainsRune(",;\t|", r):
			counts[r]++
		}
	}
	return busiest(counts)
}

func busiest(counts map[rune]int) rune {
	best := ','
	for _, candidate := range []rune{';', '\t', '|'} {
		if counts[candidate] > counts[best] {
			best = candidate
		}
	}
	return best
}

// readCSV streams a delimited text file. Only rows the profile may still need keep their text.
func readCSV(f io.ReaderAt, size int64, showUnconfirmed bool) (Table, error) {
	file := io.NewSectionReader(f, 0, size)
	sample := head(f, sampleBytes)
	encoding, decoder, err := decoderFor(sample)
	if err != nil {
		return Table{}, err
	}
	decoded, _ := io.ReadAll(transform.NewReader(bytes.NewReader(sample), decoder))
	delimiter := delimiterOf(string(decoded))
	decoder.Reset()

	limited := &recordLimiter{in: transform.NewReader(file, decoder), comma: byte(delimiter)} //nolint:gosec // delimiterOf only returns ASCII
	reader := csv.NewReader(bufio.NewReader(limited))
	reader.Comma = delimiter
	reader.LazyQuotes = true
	reader.FieldsPerRecord = -1
	reader.ReuseRecord = true
	p := &profile{}
	var cells []cell
	for {
		record, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return Table{}, err
		}
		if len(record) > maxColumns {
			return Table{}, errTooLarge
		}
		cells = cells[:0]
		for col, field := range record {
			if strings.TrimSpace(field) == "" {
				continue
			}
			c := cell{col: col, isText: true, shared: -1}
			if p.wantsValues() {
				c.text = field[:min(len(field), maxKeptBytes)]
			}
			cells = append(cells, c)
		}
		line, _ := reader.FieldPos(0)
		p.add(line, cells)
	}
	sheet := p.sheet(func(c cell) string { return c.text }, showUnconfirmed)
	return Table{Format: "csv", Encoding: encoding, Delimiter: string(delimiter), Sheets: []Sheet{sheet}}, nil
}

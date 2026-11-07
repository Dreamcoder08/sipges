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

// quoteAwareReader fails on one logical record larger than the limit. Inside a quoted field a
// newline does not end the record, and csv.Reader holds all of it in memory.
type quoteAwareReader struct {
	in     io.Reader
	quoted bool
	run    int
}

func (q *quoteAwareReader) Read(p []byte) (int, error) {
	n, err := q.in.Read(p)
	for _, c := range p[:n] {
		switch {
		case c == '"':
			q.quoted = !q.quoted
		case c == '\n' && !q.quoted:
			q.run = 0
		}
		if q.run++; q.run > runLimit {
			return 0, errTooLarge
		}
	}
	return n, err
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

	reader := csv.NewReader(bufio.NewReader(&quoteAwareReader{in: transform.NewReader(file, decoder)}))
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
			c := cell{col: col, kind: kindText, shared: -1}
			if looksNumeric(field) {
				c.kind = kindNumber
			}
			if p.wantsValues() {
				c.text = field
			}
			cells = append(cells, c)
		}
		line, _ := reader.FieldPos(0)
		p.add(line, cells)
	}
	sheet := p.sheet(func(c cell) string { return c.text }, showUnconfirmed)
	return Table{Format: "csv", Encoding: encoding, Delimiter: string(delimiter), Sheets: []Sheet{sheet}}, nil
}

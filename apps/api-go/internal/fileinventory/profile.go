package fileinventory

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The first rows a sheet may spend on titles before the header, and how far below the header the
// evidence that it is one is gathered.
const (
	headerWindow  = 20
	evidenceRows  = 200
	maxLabelRunes = 64
)

// Why a sheet or a cell has no name in the report.
const (
	WithheldUnconfirmed = "unconfirmed"
	WithheldCell        = "[withheld]"
)

type cellKind int

const (
	kindOther cellKind = iota
	kindText
	kindNumber
)

// cell is one filled cell. text is set only while a row may still become the header, and a shared
// string stays an index until the header is known, so data rows never hold a value.
type cell struct {
	col    int
	kind   cellKind
	text   string
	shared int
}

var (
	numberShape = regexp.MustCompile(`^[+-]?\d[\d.,\s]*%?$`)
	dateShape   = regexp.MustCompile(`^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}([ T].*)?$`)
	longNumber  = regexp.MustCompile(`\d{5}`)
)

func looksNumeric(text string) bool {
	text = strings.TrimSpace(text)
	return numberShape.MatchString(text) || dateShape.MatchString(text)
}

// isLabel keeps a header cell only when it reads like a column's name. It cannot catch every
// value, which is why a whole row also needs the evidence of the rows below it.
func isLabel(text string) bool {
	count := utf8.RuneCountInString(text)
	return count > 0 && count <= maxLabelRunes && !looksNumeric(text) && !longNumber.MatchString(text) &&
		!strings.Contains(text, "@") && !strings.Contains(text, "://")
}

func cleanLabel(text string) string {
	fields := strings.FieldsFunc(text, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) })
	return strings.Join(fields, " ")
}

type columnEvidence struct{ numbers, others int }

// profile watches a sheet's rows go by and keeps its shape: the row that names the columns, and
// counts. The header is the first filled row, unless that row has a lone cell, which is a title
// as long as a wider row follows within the window.
type profile struct {
	filled    int
	header    []cell
	headerRow int
	headerAt  int
	evidence  map[int]*columnEvidence
}

func (p *profile) wantsValues() bool {
	return p.header == nil || (len(p.header) < 2 && p.filled < headerWindow)
}

func (p *profile) add(number int, cells []cell) {
	if len(cells) == 0 {
		return
	}
	p.filled++
	if p.header == nil || (len(p.header) < 2 && len(cells) >= 2 && p.filled <= headerWindow) {
		p.header = append([]cell(nil), cells...)
		p.headerRow = number
		p.headerAt = p.filled
		p.evidence = map[int]*columnEvidence{}
		return
	}
	if p.filled-p.headerAt > evidenceRows {
		return
	}
	for _, c := range cells {
		seen := p.evidence[c.col]
		if seen == nil {
			seen = &columnEvidence{}
			p.evidence[c.col] = seen
		}
		if c.kind == kindNumber {
			seen.numbers++
		} else {
			seen.others++
		}
	}
}

// confirmed is true when some column is named by text and holds nothing but numbers or dates
// below: a data row sits on top of rows shaped like itself, and a header does not.
func (p *profile) confirmed() bool {
	for _, c := range p.header {
		if seen := p.evidence[c.col]; c.kind == kindText && seen != nil && seen.numbers > 0 && seen.others == 0 {
			return true
		}
	}
	return false
}

func (p *profile) sheet(resolve func(cell) string, showUnconfirmed bool) Sheet {
	sheet := Sheet{HeaderRow: p.headerRow}
	if p.header == nil {
		return sheet
	}
	sheet.DataRows = p.filled - p.headerAt
	for _, c := range p.header {
		sheet.Columns = max(sheet.Columns, c.col+1)
	}
	if !showUnconfirmed && !p.confirmed() {
		sheet.HeadersWithheld = WithheldUnconfirmed
		return sheet
	}
	sheet.Headers = make([]string, sheet.Columns)
	for _, c := range p.header {
		label := WithheldCell
		if c.kind == kindText {
			if text := cleanLabel(resolve(c)); isLabel(text) {
				label = text
			}
		}
		sheet.Headers[c.col] = label
	}
	return sheet
}

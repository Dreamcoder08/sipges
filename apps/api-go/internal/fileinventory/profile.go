package fileinventory

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The first rows a sheet may spend on titles before the header, how long a name may be, and how
// much of a candidate cell is kept in memory: past that it can no longer be a name anyway.
const (
	headerWindow  = 20
	maxLabelRunes = 64
	maxKeptBytes  = 1 << 10
)

// Why a sheet or a cell has no name in the report.
const (
	WithheldUnconfirmed = "unconfirmed"
	WithheldCell        = "[withheld]"
)

// cell is one filled cell. text is set only while a row may still become the header, and a shared
// string stays an index until the header is known, so data rows never hold a value.
type cell struct {
	col    int
	isText bool
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

// isLabel keeps a header cell only when it reads like a column's name. It is the last guard, for
// a row the file marks or the owner asked to see; it cannot catch every value.
func isLabel(text string) bool {
	count := utf8.RuneCountInString(text)
	return count > 0 && count <= maxLabelRunes && !looksNumeric(text) && !longNumber.MatchString(text) &&
		!strings.Contains(text, "@") && !strings.Contains(text, "://")
}

func cleanLabel(text string) string {
	fields := strings.FieldsFunc(text, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) })
	return strings.Join(fields, " ")
}

// profile watches a sheet's rows go by and keeps its shape: the row that may name the columns, and
// counts. That row is the first filled one, unless it has a lone cell, which is a title as long as
// a wider row follows within the window. No content can prove it names columns: "Juan Perez" above
// a column of numbers reads exactly like "Monto" above one. So its text is shown only when the
// file itself marks that row, with a filter or a frozen pane, or the owner asks.
type profile struct {
	filled    int
	header    []cell
	headerRow int
	headerAt  int
	marked    bool
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
	}
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
	if !showUnconfirmed && !p.marked {
		sheet.HeadersWithheld = WithheldUnconfirmed
		return sheet
	}
	sheet.Headers = make([]string, sheet.Columns)
	for _, c := range p.header {
		label := WithheldCell
		if c.isText {
			if text := cleanLabel(resolve(c)); isLabel(text) {
				label = text
			}
		}
		sheet.Headers[c.col] = label
	}
	return sheet
}

package fileinventory

import (
	"archive/zip"
	"encoding/xml"
	"errors"
	"io"
	"path"
	"strconv"
	"strings"
)

var errNotWorkbook = errors.New("not a workbook")

type xlsxSheet struct {
	name   string
	hidden bool
	target string
}

// readWorkbook streams each sheet's XML and keeps only its profile, then streams the shared
// strings once and keeps only the cells of the header rows.
func readWorkbook(f io.ReaderAt, size int64, showUnconfirmed bool) ([]Sheet, error) {
	archive, err := zip.NewReader(f, size)
	if err != nil {
		return nil, err
	}
	book := workbookParts{parts: make(map[string]*zip.File, len(archive.File)), budget: unpackLimit}
	for _, part := range archive.File {
		book.parts[part.Name] = part
	}
	listed, sharedPath, err := book.listSheets()
	if err != nil {
		return nil, err
	}
	profiles := make([]*profile, len(listed))
	wanted := map[int]string{}
	for i, sheet := range listed {
		profiles[i] = &profile{}
		if err := book.read(sheet.target, func(r io.Reader) error { return scanSheet(r, profiles[i]) }); err != nil {
			return nil, err
		}
		for _, c := range profiles[i].header {
			if c.shared >= 0 {
				wanted[c.shared] = ""
			}
		}
	}
	if len(wanted) > 0 {
		if err := book.read(sharedPath, func(r io.Reader) error { return readShared(r, wanted) }); err != nil {
			return nil, err
		}
	}
	resolve := func(c cell) string {
		if c.shared >= 0 {
			return wanted[c.shared]
		}
		return c.text
	}
	sheets := make([]Sheet, len(listed))
	for i, sheet := range listed {
		sheets[i] = profiles[i].sheet(resolve, showUnconfirmed)
		sheets[i].Name = sheet.name
		sheets[i].Hidden = sheet.hidden
	}
	return sheets, nil
}

type workbookParts struct {
	parts  map[string]*zip.File
	budget int64
}

func (b *workbookParts) read(name string, read func(io.Reader) error) error {
	part := b.parts[name]
	if part == nil {
		return errNotWorkbook
	}
	body, err := part.Open()
	if err != nil {
		return err
	}
	defer func() { _ = body.Close() }()
	return read(bounded(body, &b.budget, '<', runLimit))
}

func attr(el xml.StartElement, name string) string {
	for _, a := range el.Attr {
		if a.Name.Local == name {
			return a.Value
		}
	}
	return ""
}

func eachStart(r io.Reader, visit func(xml.StartElement)) error {
	dec := xml.NewDecoder(r)
	for {
		token, err := dec.RawToken()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if el, ok := token.(xml.StartElement); ok {
			visit(el)
		}
	}
}

func (b *workbookParts) listSheets() ([]xlsxSheet, string, error) {
	targets := map[string]string{}
	shared := "xl/sharedStrings.xml"
	err := b.read("xl/_rels/workbook.xml.rels", func(r io.Reader) error {
		return eachStart(r, func(el xml.StartElement) {
			if el.Name.Local != "Relationship" {
				return
			}
			switch kind := attr(el, "Type"); {
			case strings.HasSuffix(kind, "/worksheet"):
				targets[attr(el, "Id")] = attr(el, "Target")
			case strings.HasSuffix(kind, "/sharedStrings"):
				shared = partPath(attr(el, "Target"))
			}
		})
	})
	if err != nil {
		return nil, "", err
	}
	var sheets []xlsxSheet
	err = b.read("xl/workbook.xml", func(r io.Reader) error {
		return eachStart(r, func(el xml.StartElement) {
			if el.Name.Local != "sheet" {
				return
			}
			// A chart sheet is listed here too, and has no rows to look at.
			if target, ok := targets[attr(el, "id")]; ok {
				sheets = append(sheets, xlsxSheet{
					name: attr(el, "name"), hidden: attr(el, "state") != "" && attr(el, "state") != "visible",
					target: partPath(target),
				})
			}
		})
	})
	if err != nil {
		return nil, "", err
	}
	if len(sheets) == 0 {
		return nil, "", errNotWorkbook
	}
	return sheets, shared, nil
}

// partPath resolves a relationship target, which is relative to xl/ unless it starts at the root.
func partPath(target string) string {
	if strings.HasPrefix(target, "/") {
		return strings.TrimPrefix(path.Clean(target), "/")
	}
	return path.Join("xl", target)
}

// columnOf reads the column of a reference like BC12; without one, a cell follows the last. It
// stops counting past the last column a sheet can have.
func columnOf(ref string, next int) int {
	col := 0
	for _, r := range ref {
		if r < 'A' || r > 'Z' || col > maxColumns {
			break
		}
		col = col*26 + int(r-'A') + 1
	}
	if col == 0 {
		return next
	}
	return col - 1
}

// rowOf reads the first row of a reference like B3:F90.
func rowOf(ref string) int {
	digits := strings.TrimLeft(ref, "ABCDEFGHIJKLMNOPQRSTUVWXYZ$")
	if end := strings.IndexFunc(digits, func(r rune) bool { return r < '0' || r > '9' }); end >= 0 {
		digits = digits[:end]
	}
	row, err := strconv.Atoi(digits)
	if err != nil {
		return 0
	}
	return row
}

// scanSheet feeds the profile row by row. Text is copied only while the profile may still need
// it; below the header a cell is a kind and nothing else.
func scanSheet(r io.Reader, p *profile) error {
	dec := xml.NewDecoder(r)
	var (
		cells     []cell
		current   cell
		typeAttr  string
		inCell    bool
		inText    bool
		phonetic  bool
		hasValue  bool
		value     strings.Builder
		rowNumber int
		nextCol   int
		markedRow = map[int]bool{}
	)
	for {
		token, err := dec.RawToken()
		if errors.Is(err, io.EOF) {
			p.marked = markedRow[p.headerRow]
			return nil
		}
		if err != nil {
			return err
		}
		switch el := token.(type) {
		case xml.StartElement:
			switch el.Name.Local {
			case "pane":
				if strings.HasPrefix(attr(el, "state"), "frozen") {
					if rows, err := strconv.Atoi(attr(el, "ySplit")); err == nil {
						markedRow[rows] = true
					}
				}
			case "autoFilter":
				markedRow[rowOf(attr(el, "ref"))] = true
			case "row":
				cells, nextCol = cells[:0], 0
				rowNumber++
				if number, err := strconv.Atoi(attr(el, "r")); err == nil {
					rowNumber = number
				}
			case "c":
				current = cell{col: columnOf(attr(el, "r"), nextCol), shared: -1}
				nextCol = current.col + 1
				if nextCol > maxColumns || len(cells) >= maxColumns {
					return errTooLarge
				}
				typeAttr, inCell, hasValue = attr(el, "t"), true, false
				value.Reset()
			case "v", "t":
				inText = inCell && !phonetic
			case "rPh":
				phonetic = true
			}
		case xml.CharData:
			if inText && len(el) > 0 {
				hasValue = true
				if p.wantsValues() && value.Len() < maxKeptBytes {
					value.Write(el[:min(len(el), maxKeptBytes)])
				}
			}
		case xml.EndElement:
			switch el.Name.Local {
			case "v", "t":
				inText = false
			case "rPh":
				phonetic = false
			case "c":
				inCell = false
				if hasValue {
					cells = append(cells, finishCell(current, typeAttr, value.String(), p.wantsValues()))
				}
			case "row":
				p.add(rowNumber, cells)
			}
		}
	}
}

func finishCell(c cell, typeAttr, value string, keep bool) cell {
	switch typeAttr {
	case "s":
		c.isText = true
		if keep {
			if index, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
				c.shared = index
			}
		}
	case "str", "inlineStr":
		c.isText = true
		c.text = value
	}
	return c
}

// readShared fills in the wanted strings. Each is one <si>, its text split across <t> elements,
// with phonetic hints left out.
func readShared(r io.Reader, wanted map[int]string) error {
	dec := xml.NewDecoder(r)
	index := -1
	inText, phonetic := false, false
	for {
		token, err := dec.RawToken()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		switch el := token.(type) {
		case xml.StartElement:
			switch el.Name.Local {
			case "si":
				index++
			case "rPh":
				phonetic = true
			case "t":
				inText = !phonetic
			}
		case xml.EndElement:
			switch el.Name.Local {
			case "rPh":
				phonetic = false
			case "t":
				inText = false
			}
		case xml.CharData:
			if text, keep := wanted[index]; keep && inText && len(text) < maxKeptBytes {
				wanted[index] = text + string(el[:min(len(el), maxKeptBytes)])
			}
		}
	}
}

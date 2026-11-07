package fileinventory

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"unicode/utf16"

	"golang.org/x/text/encoding/charmap"
)

// Every synthetic cell value below a header carries this mark, so one search proves none left.
const canary = "CANARY"

// view and after are what Excel writes around the rows: a frozen pane, a filter.
type sheetXML struct {
	name, state, rows, view, after string
}

func frozen(rows int) string {
	return fmt.Sprintf(`<sheetViews><sheetView><pane ySplit="%d" topLeftCell="A2" state="frozen"/></sheetView></sheetViews>`, rows)
}

func workbook(t *testing.T, shared []string, sheets ...sheetXML) []byte {
	t.Helper()
	var list, rels strings.Builder
	parts := map[string]string{}
	for i, s := range sheets {
		id := strconv.Itoa(i + 1)
		state := ""
		if s.state != "" {
			state = ` state="` + s.state + `"`
		}
		fmt.Fprintf(&list, `<sheet name="%s" sheetId="%s"%s r:id="rId%s"/>`, s.name, id, state, id)
		fmt.Fprintf(&rels, `<Relationship Id="rId%s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%s.xml"/>`, id, id)
		parts["xl/worksheets/sheet"+id+".xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="x"><dimension ref="A1"/>` + s.view + `<sheetData>` + s.rows + `</sheetData>` + s.after + `</worksheet>`
	}
	parts["xl/workbook.xml"] = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns:r="r"><sheets>` + list.String() + `</sheets></workbook>`
	parts["xl/_rels/workbook.xml.rels"] = `<Relationships>` + rels.String() + `</Relationships>`
	var strs strings.Builder
	for _, s := range shared {
		strs.WriteString("<si><t>" + s + "</t></si>")
	}
	parts["xl/sharedStrings.xml"] = `<sst>` + strs.String() + `</sst>`
	return zipped(t, parts)
}

func s(ref string, index int) string { return fmt.Sprintf(`<c r="%s" t="s"><v>%d</v></c>`, ref, index) }
func n(ref, value string) string     { return fmt.Sprintf(`<c r="%s"><v>%s</v></c>`, ref, value) }
func row(index int, cells ...string) string {
	return fmt.Sprintf(`<row r="%d">%s</row>`, index, strings.Join(cells, ""))
}

func scanShowing(t *testing.T, root string) Report {
	t.Helper()
	report, err := Scan(context.Background(), root, Options{ShowUnconfirmedHeaders: true})
	if err != nil {
		t.Fatal(err)
	}
	return report
}

func tableOf(t *testing.T, r Report, path string) Table {
	t.Helper()
	for _, table := range r.Tables {
		if table.Path == path {
			return table
		}
	}
	t.Fatalf("no table %s in %+v", path, r.Tables)
	return Table{}
}

func noCanary(t *testing.T, r Report) {
	t.Helper()
	body, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(body, []byte(canary)) {
		t.Fatalf("a cell value reached the report: %s", body)
	}
	var out bytes.Buffer
	r.WriteSummary(&out)
	if strings.Contains(out.String(), canary) {
		t.Fatalf("a cell value reached the terminal: %s", out.String())
	}
}

func TestXLSXGivesSheetsHeadersAndRowCountsAndNoValue(t *testing.T) {
	root := t.TempDir()
	put(t, root, "book.xlsx", workbook(t,
		[]string{"Código", "Nombre", "Monto", "Fecha", canary + " person", canary + " other"},
		sheetXML{name: "Concesiones", view: frozen(1), rows: row(1, s("A1", 0), s("B1", 1), s("C1", 2)) +
			row(2, n("A2", "1001"), s("B2", 4), n("C2", "12.5")) +
			row(3, n("A3", "1002"), s("B3", 5), n("C3", "13.5")) +
			// A styled empty row is not a row of data.
			`<row r="4"><c r="A4" s="3"/><c r="B4" s="3"/></row>`},
		sheetXML{name: "Oculta", state: "hidden", after: `<autoFilter ref="A1:B2"/>`,
			rows: row(1, s("A1", 3), s("B1", 1)) + row(2, n("A2", "45000"), s("B2", 4))},
	))

	r := scan(t, root)

	noCanary(t, r)
	table := tableOf(t, r, "book.xlsx")
	if table.Format != "xlsx" || len(table.Sheets) != 2 {
		t.Fatalf("%+v", table)
	}
	first, second := table.Sheets[0], table.Sheets[1]
	if first.Name != "Concesiones" || first.DataRows != 2 || first.HeaderRow != 1 || first.Columns != 3 ||
		strings.Join(first.Headers, "|") != "Código|Nombre|Monto" || first.Hidden {
		t.Errorf("first: %+v", first)
	}
	if second.Name != "Oculta" || !second.Hidden || second.DataRows != 1 || strings.Join(second.Headers, "|") != "Fecha|Nombre" {
		t.Errorf("second: %+v", second)
	}
	if file(t, r, "book.xlsx").Status != StatusReadable {
		t.Errorf("%+v", file(t, r, "book.xlsx"))
	}
}

func TestXLSXSkipsATitleAboveTheHeader(t *testing.T) {
	root := t.TempDir()
	put(t, root, "book.xlsm", workbook(t, []string{"REPORTE " + canary, "Código", "Monto"},
		sheetXML{name: "Datos", view: frozen(3), rows: row(1, s("A1", 0)) + row(3, s("A3", 1), s("C3", 2)) + row(4, n("A4", "1"), n("C4", "2"))}))

	r := scan(t, root)

	noCanary(t, r)
	sheet := tableOf(t, r, "book.xlsm").Sheets[0]
	if sheet.HeaderRow != 3 || sheet.DataRows != 1 || strings.Join(sheet.Headers, "|") != "Código||Monto" {
		t.Errorf("%+v", sheet)
	}
}

func TestXLSXInlineAndRichStrings(t *testing.T) {
	root := t.TempDir()
	body := workbook(t, nil, sheetXML{name: "Datos", view: frozen(1), rows: row(1,
		`<c r="A1" t="inlineStr"><is><t>Zona</t></is></c>`,
		`<c r="B1" t="inlineStr"><is><r><t>Área </t></r><r><t>total</t></r><rPh><t>ignored</t></rPh></is></c>`) +
		row(2, `<c r="A2" t="inlineStr"><is><t>`+canary+`</t></is></c>`, n("B2", "1"))})
	put(t, root, "inline.xlsx", body)

	r := scan(t, root)

	noCanary(t, r)
	if got := tableOf(t, r, "inline.xlsx").Sheets[0].Headers; strings.Join(got, "|") != "Zona|Área total" {
		t.Errorf("%q", got)
	}
}

// Rows that look exactly like a header above numbers: nothing tells a column's name from a person's,
// so by default only the file itself can say which row is the header.
func TestAFirstRowIsNeverShownUnlessTheFileMarksIt(t *testing.T) {
	cases := map[string]string{
		"data-over-numbers.csv": canary + " Juan Perez,pendiente,Lima\nMaria Lopez,1200,Cusco\nRosa Diaz,1300,Puno\n",
		"key-value.csv":         "Cliente:," + canary + " Juan Perez\n1,2\n3,4\n",
		"single.csv":            canary + " Juan Perez\n12\n13\n",
		"after-title.csv":       "Reporte\n" + canary + " Maria Lopez,-\n1,2\n",
		"all-text.csv":          canary + " a," + canary + " b\n" + canary + " c," + canary + " d\n",
	}
	root := t.TempDir()
	for name, body := range cases {
		put(t, root, name, []byte(body))
	}
	put(t, root, "unmarked.xlsx", workbook(t, []string{canary + " Juan Perez", "pendiente"},
		sheetXML{name: "Datos", rows: row(1, s("A1", 0), s("B1", 1)) + row(2, s("A2", 0), n("B2", "1"))}))
	put(t, root, "marked-elsewhere.xlsx", workbook(t, []string{canary + " Juan Perez", "pendiente"},
		sheetXML{name: "Datos", view: frozen(5), after: `<autoFilter ref="A7:B9"/>`, rows: row(1, s("A1", 0), s("B1", 1)) + row(2, s("A2", 0), n("B2", "1"))}))

	r := scan(t, root)

	noCanary(t, r)
	if len(r.Tables) != len(cases)+2 {
		t.Fatalf("%+v", r.Tables)
	}
	for _, table := range r.Tables {
		sheet := table.Sheets[0]
		if sheet.Headers != nil || sheet.HeadersWithheld != WithheldUnconfirmed || sheet.Columns == 0 || sheet.DataRows == 0 {
			t.Errorf("%s: %+v", table.Path, sheet)
		}
	}
	if got := tableOf(t, scanShowing(t, root), "single.csv").Sheets[0]; got.Headers == nil || got.HeadersWithheld != "" {
		t.Errorf("asked to show: %+v", got)
	}
}

// A person's document, mail or date in the first row is withheld even when the owner asks to see
// unconfirmed headers.
func TestAHeaderCellThatLooksLikeAValueIsWithheld(t *testing.T) {
	root := t.TempDir()
	put(t, root, "values.csv", []byte(strings.Join([]string{
		"Nombre,12345678,ana@example.org,2026-01-31,https://example.org/x," + strings.Repeat("y", 90) + ",Año 2026",
		"x,1,2,3,4,5,6",
	}, "\n")))

	r, err := Scan(context.Background(), root, Options{ShowUnconfirmedHeaders: true})
	if err != nil {
		t.Fatal(err)
	}
	got := tableOf(t, r, "values.csv").Sheets[0].Headers
	want := []string{"Nombre", WithheldCell, WithheldCell, WithheldCell, WithheldCell, WithheldCell, "Año 2026"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("%q", got)
	}
}

func TestCSVDialects(t *testing.T) {
	latin1, err := charmap.Windows1252.NewEncoder().String("Código;Año;Región\n1;2026;" + canary + "\n2;2025;" + canary + "\n")
	if err != nil {
		t.Fatal(err)
	}
	var utf16le bytes.Buffer
	utf16le.Write([]byte{0xFF, 0xFE})
	for _, unit := range utf16.Encode([]rune("Código\tMonto\r\n" + canary + "\t12\r\n")) {
		utf16le.Write([]byte{byte(unit), byte(unit >> 8)})
	}
	cases := []struct {
		name      string
		body      []byte
		encoding  string
		delimiter string
		headers   string
		rows      int
	}{
		{"comma.csv", []byte("Código,Monto\n" + canary + ",12\n" + canary + ",13\n"), "utf-8", ",", "Código|Monto", 2},
		{"bom.csv", []byte("\xEF\xBB\xBFCódigo,Monto\n" + canary + ",12\n"), "utf-8", ",", "Código|Monto", 1},
		{"excel.csv", []byte(latin1), "windows-1252", ";", "Código|Año|Región", 2},
		{"unicode.csv", utf16le.Bytes(), "utf-16", "\t", "Código|Monto", 1},
		{"tabs.tsv", []byte("Código\tMonto\n" + canary + "\t12\n"), "utf-8", "\t", "Código|Monto", 1},
		{"sep.csv", []byte("sep=;\nCódigo;Monto\n" + canary + ";12\n"), "utf-8", ";", "Código|Monto", 1},
		{"quoted.csv", []byte("\"Código, largo\",Monto\n\"" + canary + "\nline two\",12\n\n"), "utf-8", ",", "Código, largo|Monto", 1},
	}
	root := t.TempDir()
	for _, c := range cases {
		put(t, root, c.name, c.body)
	}
	r := scanShowing(t, root)
	noCanary(t, r)
	for _, c := range cases {
		table := tableOf(t, r, c.name)
		sheet := table.Sheets[0]
		if table.Format != "csv" || table.Encoding != c.encoding || table.Delimiter != c.delimiter ||
			strings.Join(sheet.Headers, "|") != c.headers || sheet.DataRows != c.rows {
			t.Errorf("%s: %+v %+v", c.name, table, sheet)
		}
	}
}

func TestBrokenSpreadsheets(t *testing.T) {
	good := workbook(t, []string{"Código"}, sheetXML{name: "Datos", rows: row(1, s("A1", 0))})
	noSheetPart := zipped(t, map[string]string{
		"xl/workbook.xml":            `<workbook><sheets><sheet name="Datos" r:id="rId1"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<Relationships/>`,
	})
	cases := []struct {
		name   string
		body   []byte
		reason string
	}{
		{"cut.xlsx", good[:len(good)/2], ReasonCorrupt},
		{"text.xlsx", []byte("not a workbook"), ReasonCorrupt},
		{"locked.xlsx", olePrefix, ReasonEncrypted},
		{"other-zip.xlsx", zipped(t, map[string]string{"a.txt": "x"}), ReasonCorrupt},
		{"no-part.xlsx", noSheetPart, ReasonCorrupt},
		{"binary.csv", []byte("a,b\x00\x01\x02\n"), ReasonCorrupt},
	}
	root := t.TempDir()
	for _, c := range cases {
		put(t, root, c.name, c.body)
	}
	r := scan(t, root)
	for _, c := range cases {
		if got := file(t, r, c.name); got.Status != StatusUnreadable || got.Reason != c.reason {
			t.Errorf("%s: %+v", c.name, got)
		}
	}
	if len(r.Tables) != 0 {
		t.Errorf("tables from broken files: %+v", r.Tables)
	}
}

// A crafted file must cost one line in the report, not the memory of the run.
func TestRunsLargerThanTheLimitStopTheFileOnly(t *testing.T) {
	oldRun := runLimit
	runLimit = 1 << 16
	t.Cleanup(func() { runLimit = oldRun })
	huge := strings.Repeat("y", 1<<17)
	root := t.TempDir()
	put(t, root, "huge.xlsx", workbook(t, []string{huge}, sheetXML{name: "Datos", rows: row(1, s("A1", 0))}))
	put(t, root, "huge.csv", []byte(huge+",b\n"))
	put(t, root, "open-quote.csv", []byte("a,\""+huge+"\n"+huge+"\n"))
	put(t, root, "fine.csv", []byte("Código,Monto\nx,1\n"))

	r := scan(t, root)

	for _, path := range []string{"huge.xlsx", "huge.csv", "open-quote.csv"} {
		if got := file(t, r, path); got.Reason != ReasonTooLarge {
			t.Errorf("%s: %+v", path, got)
		}
	}
	if file(t, r, "fine.csv").Status != StatusReadable {
		t.Error("the file after them was not read")
	}
}

func TestSummaryCountsSheetsAndNamesNone(t *testing.T) {
	root := t.TempDir()
	put(t, root, "book.xlsx", workbook(t, []string{"Código"}, sheetXML{name: "SheetName", rows: row(1, s("A1", 0)) + row(2, n("A2", "1"))}))
	var out bytes.Buffer
	scan(t, root).WriteSummary(&out)
	if text := out.String(); strings.Contains(text, "SheetName") || strings.Contains(text, "Código") || !strings.Contains(text, "1 sheet") {
		t.Fatalf("%s", text)
	}
}

func TestCraftedShapesStopTheFileOnly(t *testing.T) {
	wide := make([]string, maxColumns+1)
	for i := range wide {
		wide[i] = `<c><v>1</v></c>`
	}
	root := t.TempDir()
	put(t, root, "far-column.xlsx", workbook(t, nil, sheetXML{name: "Datos", rows: `<row r="1"><c r="ZZZZZZZZZZZZZZZZ1"><v>1</v></c></row>`}))
	put(t, root, "wide-row.xlsx", workbook(t, nil, sheetXML{name: "Datos", rows: `<row r="1">` + strings.Join(wide, "") + `</row>`}))
	put(t, root, "wide.csv", []byte(strings.Repeat("1,", maxColumns+1)+"\n"))

	r := scan(t, root)

	for _, path := range []string{"far-column.xlsx", "wide-row.xlsx", "wide.csv"} {
		if got := file(t, r, path); got.Reason != ReasonTooLarge {
			t.Errorf("%s: %+v", path, got)
		}
	}
}

func TestCellsOutOfOrderKeepTheirColumns(t *testing.T) {
	root := t.TempDir()
	put(t, root, "order.xlsx", workbook(t, []string{"Monto", "Código"},
		sheetXML{name: "Datos", view: frozen(1), rows: row(1, s("C1", 0), s("A1", 1)) + row(2, n("C2", "1"), n("A2", "2"))}))

	r := scan(t, root)

	sheet := tableOf(t, r, "order.xlsx").Sheets[0]
	if sheet.Columns != 3 || strings.Join(sheet.Headers, "|") != "Código||Monto" {
		t.Errorf("%+v", sheet)
	}
}

func TestAWorkbookCannotUnpackPastItsBudget(t *testing.T) {
	old := unpackLimit
	unpackLimit = 4 << 10
	t.Cleanup(func() { unpackLimit = old })
	rows := strings.Repeat(row(1, n("A1", "1")), 40)
	root := t.TempDir()
	put(t, root, "many.xlsx", workbook(t, nil,
		sheetXML{name: "a", rows: rows}, sheetXML{name: "b", rows: rows}, sheetXML{name: "c", rows: rows}))

	r := scan(t, root)

	if got := file(t, r, "many.xlsx"); got.Reason != ReasonTooLarge {
		t.Errorf("%+v", got)
	}
}

func TestSharedStringsMayLiveElsewhere(t *testing.T) {
	root := t.TempDir()
	put(t, root, "moved.xlsx", zipped(t, map[string]string{
		"xl/workbook.xml": `<workbook><sheets><sheet name="Datos" r:id="rId1"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<Relationships>
			<Relationship Id="rId1" Type="http://x/relationships/worksheet" Target="/xl/data/one.xml"/>
			<Relationship Id="rId2" Type="http://x/relationships/sharedStrings" Target="data/strings.xml"/>
		</Relationships>`,
		"xl/data/one.xml":     `<worksheet>` + row(1, s("A1", 0), s("B1", 1)) + row(2, n("A2", "1"), n("B2", "2")) + `</worksheet>`,
		"xl/data/strings.xml": `<sst><si><t>Zona</t></si><si><t>Monto</t></si></sst>`,
	}))

	r := scanShowing(t, root)

	if got := tableOf(t, r, "moved.xlsx").Sheets[0].Headers; strings.Join(got, "|") != "Zona|Monto" {
		t.Errorf("%q %+v", got, r.Files)
	}
}

func TestABlankLineAfterTheHeaderLeavesItsLineNumber(t *testing.T) {
	root := t.TempDir()
	put(t, root, "gap.csv", []byte("Título\nCódigo,Monto\n,,\nx,1\n"))
	sheet := tableOf(t, scanShowing(t, root), "gap.csv").Sheets[0]
	if sheet.HeaderRow != 2 || sheet.DataRows != 1 {
		t.Errorf("%+v", sheet)
	}
}

// One stray inch mark must not turn the rest of a large file into a single quoted field.
func TestAStrayQuoteIsNotARecord(t *testing.T) {
	oldRun := runLimit
	runLimit = 1 << 16
	t.Cleanup(func() { runLimit = oldRun })
	root := t.TempDir()
	put(t, root, "inch.csv", []byte("Pieza,Monto\nTubo 5\" acero,3\n"+strings.Repeat("otra pieza,1\n", 1<<14)))
	put(t, root, "doubled.csv", []byte("a,\"say \"\"hi\"\" there\n"+strings.Repeat("y", 1<<17)+"\n\"\n"))

	r := scan(t, root)

	if got := file(t, r, "inch.csv"); got.Status != StatusReadable {
		t.Errorf("%+v", got)
	}
	if got := tableOf(t, r, "inch.csv").Sheets[0]; got.DataRows != 1<<14+1 {
		t.Errorf("%+v", got)
	}
	if got := file(t, r, "doubled.csv"); got.Reason != ReasonTooLarge {
		t.Errorf("a doubled quote ended the field: %+v", got)
	}
}

// Comments and CDATA are the only way past the limit, because the decoder holds each whole, and
// a spreadsheet has no use for them.
func TestMarkupThatHidesFromTheLimitStopsTheFile(t *testing.T) {
	root := t.TempDir()
	comment := workbook(t, nil, sheetXML{name: "Datos", rows: `<!-- x -->` + row(1, n("A1", "1"))})
	cdata := workbook(t, nil, sheetXML{name: "Datos", rows: row(1, `<c r="A1" t="inlineStr"><is><t><![CDATA[x]]></t></is></c>`)})
	put(t, root, "comment.xlsx", comment)
	put(t, root, "cdata.xlsx", cdata)

	r := scan(t, root)

	for _, path := range []string{"comment.xlsx", "cdata.xlsx"} {
		if got := file(t, r, path); got.Reason != ReasonCorrupt {
			t.Errorf("%s: %+v", path, got)
		}
	}
}

func TestACellSplitIntoManyTextElementsKeepsOnlyItsStart(t *testing.T) {
	inline := `<c r="A1" t="inlineStr"><is>` + strings.Repeat("<t>"+strings.Repeat("y", 1024)+"</t>", 64) + `</is></c>`
	shared := strings.Repeat("y", 1024)
	root := t.TempDir()
	put(t, root, "split.xlsx", workbook(t, []string{shared},
		sheetXML{name: "Datos", rows: row(1, inline, s("B1", 0)) + row(2, n("A2", "1"), n("B2", "2"))}))

	got := tableOf(t, scanShowing(t, root), "split.xlsx").Sheets[0].Headers

	if strings.Join(got, "|") != WithheldCell+"|"+WithheldCell {
		t.Errorf("%q", got)
	}
}

func TestAProcessingInstructionCannotHideARun(t *testing.T) {
	oldRun := runLimit
	runLimit = 1 << 16
	t.Cleanup(func() { runLimit = oldRun })
	root := t.TempDir()
	body := workbook(t, nil, sheetXML{name: "Datos", rows: `<?x ` + strings.Repeat("<", 1<<17) + `?>` + row(1, n("A1", "1"))})
	put(t, root, "pi.xlsx", body)
	put(t, root, "fine.xlsx", workbook(t, nil, sheetXML{name: "Datos", rows: `<?keep this?>` + row(1, n("A1", "1"))}))

	r := scan(t, root)

	if got := file(t, r, "pi.xlsx"); got.Reason != ReasonTooLarge {
		t.Errorf("%+v", got)
	}
	if got := file(t, r, "fine.xlsx"); got.Status != StatusReadable {
		t.Errorf("a short instruction is harmless: %+v", got)
	}
}

func TestAWorkbookCannotListWithoutLimit(t *testing.T) {
	many := make([]sheetXML, maxSheets+1)
	for i := range many {
		many[i] = sheetXML{name: "s" + strconv.Itoa(i), rows: row(1, n("A1", "1"))}
	}
	wide := make([]string, 16000)
	for i := range wide {
		wide[i] = `<c><v>1</v></c>`
	}
	wideRow := `<row r="1">` + strings.Join(wide, "") + `</row>`
	var heavy []sheetXML
	for i := range 5 {
		heavy = append(heavy, sheetXML{name: "s" + strconv.Itoa(i), rows: wideRow})
	}
	root := t.TempDir()
	put(t, root, "many-sheets.xlsx", workbook(t, nil, many...))
	put(t, root, "long-name.xlsx", workbook(t, nil, sheetXML{name: strings.Repeat("n", maxNameBytes+1), rows: row(1, n("A1", "1"))}))
	put(t, root, "many-header-cells.xlsx", workbook(t, nil, heavy...))
	put(t, root, "long-target.xlsx", zipped(t, map[string]string{
		"xl/workbook.xml": `<workbook><sheets><sheet name="Datos" r:id="rId1"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="` +
			strings.Repeat("t", maxNameBytes+1) + `"/></Relationships>`,
	}))

	r := scan(t, root)

	for _, path := range []string{"many-sheets.xlsx", "long-name.xlsx", "many-header-cells.xlsx", "long-target.xlsx"} {
		if got := file(t, r, path); got.Reason != ReasonTooLarge {
			t.Errorf("%s: %+v", path, got)
		}
	}
}

// csv.Reader ends a quoted field only at a quote before a delimiter or a line end, so the limiter
// must not call the record over at a quote followed by text.
func TestAQuoteFollowedByTextStaysQuoted(t *testing.T) {
	oldRun := runLimit
	runLimit = 1 << 16
	t.Cleanup(func() { runLimit = oldRun })
	root := t.TempDir()
	put(t, root, "text-after-quote.csv", []byte("\"5\" pipe,b\n"+strings.Repeat("next line,2\n", 1<<14)))
	put(t, root, "closed-before-comma.csv", []byte("\"Código\",Monto\n"+strings.Repeat("\"x\",2\n", 1<<14)))
	put(t, root, "closed-crlf.csv", []byte("\"Código\",\"Monto\"\r\n"+strings.Repeat("\"x\",\"2\"\r\n", 1<<14)))

	r := scan(t, root)

	if got := file(t, r, "text-after-quote.csv"); got.Reason != ReasonTooLarge {
		t.Errorf("%+v", got)
	}
	for _, path := range []string{"closed-before-comma.csv", "closed-crlf.csv"} {
		if got := file(t, r, path); got.Status != StatusReadable {
			t.Errorf("%s: %+v", path, got)
		}
	}
}

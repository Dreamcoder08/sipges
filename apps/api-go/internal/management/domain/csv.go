package domain

import (
	"math"
	"strings"
)

// ManagementCSVFilename is MANAGEMENT_CSV_FILENAME.
const ManagementCSVFilename = "sipges_rc28_reporte_gerencial.csv"

// textCell is overview.ts `cell` for a string: a leading quote on text a spreadsheet would run
// as a formula, then RFC 4180 quoting.
func textCell(text string) string {
	if text != "" && strings.ContainsRune("=+-@\t\r", rune(text[0])) {
		text = "'" + text
	}
	return quoteCell(text)
}

// numberCell is `cell` for a number: String(value), never formula-quoted.
func numberCell(value float64) string { return quoteCell(jsNumber(value)) }

// quoteCell quotes per RFC 4180 when the text holds a quote, comma or line break.
func quoteCell(text string) string {
	if strings.ContainsAny(text, "\",\r\n") {
		return `"` + strings.ReplaceAll(text, `"`, `""`) + `"`
	}
	return text
}

func row(b *strings.Builder, cells ...string) {
	b.WriteString(strings.Join(cells, ","))
	b.WriteString("\r\n")
}

// ManagementCSV is managementCsv (app.py `rc28_export_csv`): UTF-8 with a byte order mark and
// CRLF rows like Python's csv.writer. Percentages are Python floats once there are actions, so
// 50 prints as 50.0.
func ManagementCSV(report Overview) string {
	var b strings.Builder
	b.WriteString("\ufeff")
	row(&b, textCell("SIPGES RC 2.8"), textCell("Resumen gerencial"), textCell(report.ProjectID), textCell(report.GeneratedAt))
	row(&b, "Indicador", "Valor")
	for _, m := range report.Metrics.entries() {
		value := numberCell(m.value)
		if m.float && report.Metrics.TotalActions > 0 && m.value == math.Trunc(m.value) {
			value = textCell(jsNumber(m.value) + ".0")
		}
		row(&b, textCell(m.key), value)
	}
	row(&b)
	row(&b, "Acciones críticas", "Responsable", "Plazo", "Estado", "Avance (%)") //nolint:misspell // Spanish text kept verbatim from the TypeScript API
	for _, x := range report.CriticalActions {
		row(&b, textCell(x.Title), textCell(x.Responsible), textCell(x.DueDate), textCell(x.Status), numberCell(float64(x.Progress)))
	}
	row(&b)
	row(&b, "Nota metodológica", textCell(report.Methodology))
	return b.String()
}

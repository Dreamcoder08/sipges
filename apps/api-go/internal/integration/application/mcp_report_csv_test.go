package application

import (
	"strings"
	"testing"

	sanitised "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
)

// A value a spreadsheet would run as a formula is written as text (OWASP CSV injection): a record's
// code typed as «=HYPERLINK(…)» must not become a live link or a command when the sheet opens.
func TestReportCSVNeutralisesFormulas(t *testing.T) {
	t.Parallel()
	field := "Codigo"
	r := reportJSON{GroupBy: &field, Total: 5, Groups: []countGroupJSON{
		{Value: &sanitised.Value{Text: "=HYPERLINK(\"http://x\")"}, Count: 1},
		{Value: &sanitised.Value{Text: "+1"}, Count: 1},
		{Value: &sanitised.Value{Text: "-2"}, Count: 1},
		{Value: &sanitised.Value{Text: "@SUM(A1)"}, Count: 1},
		{Value: &sanitised.Value{Number: -3, IsNumber: true}, Count: 1},
		{Value: &sanitised.Value{Text: "  =1+1"}, Count: 1},
	}}
	got := strings.TrimPrefix(reportCSV(r), csvBOM)
	want := "Codigo,cantidad\r\n\"'=HYPERLINK(\"\"http://x\"\")\",1\r\n'+1,1\r\n'-2,1\r\n'@SUM(A1),1\r\n-3,1\r\n'  =1+1,1\r\nTotal,5\r\n"
	if got != want {
		t.Errorf("csv\n got %q\nwant %q", got, want)
	}
}

// A count cut at its read limit says so in the sheet too, or the total reads as complete.
func TestReportCSVSaysWhenTheCountWasCut(t *testing.T) {
	t.Parallel()
	by := "mes"
	r := reportJSON{By: &by, Total: 20000, Truncated: true, Series: []reportPointJSON{{Period: "2026-01", Count: 20000}}}
	got := strings.TrimPrefix(reportCSV(r), csvBOM)
	want := "mes,cantidad\r\n2026-01,20000\r\nTotal,20000\r\nAviso,conteo parcial: se leyó el máximo de registros\r\n"
	if got != want {
		t.Errorf("csv\n got %q\nwant %q", got, want)
	}
}

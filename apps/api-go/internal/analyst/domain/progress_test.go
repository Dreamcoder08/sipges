package domain_test

import (
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
)

func TestCountRecordsHasItsFixedSpanishLabel(t *testing.T) {
	t.Parallel()
	if got := domain.ToolStepLabel("count_records"); got != "Contando registros…" {
		t.Fatalf("label = %q", got)
	}
}

func TestReportPeriodHasItsFixedSpanishLabel(t *testing.T) {
	t.Parallel()
	if got := domain.ToolStepLabel("report_period"); got != "Preparando el reporte…" {
		t.Fatalf("label = %q", got)
	}
}

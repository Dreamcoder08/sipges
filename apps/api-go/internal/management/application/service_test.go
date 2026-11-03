//nolint:misspell // Spanish field names and messages, verbatim from the TypeScript API.
package application

import (
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/management/domain"
)

// Ported from apps/api/src/contexts/management/application/management-service.test.ts.

func TestUsesTheLimaBusinessDayBeforeUTCMidnight(t *testing.T) {
	report := Overview("PRJ-TEST", time.Date(2026, 10, 16, 2, 0, 0, 0, time.UTC), Snapshot{
		Actions: []domain.ActionRow{{
			ID: "ACTION-TEST", AlertID: "AL-TEST", Title: "Acción de prueba", Responsible: "Equipo",
			DueDate: "2026-10-15", Status: "Pendiente",
		}},
	})
	if report.Metrics.OverdueActions != 0 {
		t.Fatalf("overdue = %d", report.Metrics.OverdueActions)
	}
	if report.GeneratedAt != "2026-10-16T02:00:00Z" || report.ProjectID != "PRJ-TEST" {
		t.Fatalf("generated_at %q project %q", report.GeneratedAt, report.ProjectID)
	}
}

func TestGeneratedAtDropsMillisecondsAndUsesUTC(t *testing.T) {
	now := time.Date(2026, 10, 15, 21, 30, 59, 999_000_000, time.FixedZone("x", -5*3600))
	if got := Overview("P", now, Snapshot{}).GeneratedAt; got != "2026-10-16T02:30:59Z" {
		t.Fatalf("generated_at = %q", got)
	}
}

func TestCommitmentsComeFromTheRecords(t *testing.T) {
	payload, err := domain.ParsePayload([]byte(`{"Responsable":"Equipo","Estado":"Vencido","Plazo":"2026-01-01"}`))
	if err != nil {
		t.Fatal(err)
	}
	report := Overview("P", time.Now(), Snapshot{Records: []domain.Record{{ID: "C1", Payload: payload}}})
	want := domain.Commitment{ID: "C1", Responsible: "Equipo", Status: "Vencido", DueDate: "2026-01-01"}
	if len(report.Commitments) != 1 || report.Commitments[0] != want || report.Metrics.OverdueCommitmentsExplicit != 1 {
		t.Fatalf("commitments = %+v", report.Commitments)
	}
}

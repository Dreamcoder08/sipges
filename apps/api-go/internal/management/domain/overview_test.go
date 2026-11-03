//nolint:misspell // Spanish field names and messages, verbatim from the TypeScript API.
package domain

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

// Ported from apps/api/src/contexts/management/domain/overview.test.ts, plus the JSON shape,
// counters, payload helpers and CSV bytes of overview.ts.

func action(id, dueDate, status string) ActionRow {
	return ActionRow{ID: id, DueDate: dueDate, Status: status, Title: id, Responsible: "Equipo"}
}

func TestCountsOnlyRealOverdueDatesOnOngoingActions(t *testing.T) {
	report := ManagementOverview(Input{
		ProjectID: "P-1",
		Today:     "2026-10-15",
		Actions: []ActionRow{
			action("blank", "", "Pendiente"),
			action("invalid", "2026-02-30", "Pendiente"),
			action("today", "2026-10-15", "Pendiente"),
			action("late", "2026-10-14", "Pendiente"),
			action("done", "2026-10-14", " CUMPLIDA "),
			action("cancel", "2026-10-14", "Cancelado"),
			action("failed", "2026-10-14", "Incumplido"),
		},
	})
	if report.Metrics.OverdueActions != 2 || report.Metrics.ActiveActions != 5 || report.Metrics.CompletedActions != 1 {
		t.Fatalf("metrics = %+v", report.Metrics)
	}
	var ids []string
	for _, a := range report.CriticalActions {
		ids = append(ids, a.ID)
	}
	if !slices.Equal(ids, []string{"late", "failed"}) {
		t.Fatalf("critical = %v", ids)
	}
}

func TestCommitmentsUseValidISODeadlinesOnly(t *testing.T) {
	records := []Record{
		record(t, "iso", `{"Proyecto_ID":"P-1","Plazo":"2026-10-15"}`),
		record(t, "text", `{"Proyecto_ID":"P-1","Plazo":"Próxima reunión"}`),
		record(t, "invalid", `{"Proyecto_ID":"P-1","Fecha_Vencimiento":"2026-02-30","Plazo":"2026-10-15"}`),
	}
	var due []string
	for _, c := range CommitmentsOf(records) {
		due = append(due, c.DueDate)
	}
	if !slices.Equal(due, []string{"2026-10-15", "", ""}) {
		t.Fatalf("due dates = %q", due)
	}
}

func record(t *testing.T, id, payload string) Record {
	t.Helper()
	p, err := ParsePayload([]byte(payload))
	if err != nil {
		t.Fatal(err)
	}
	return Record{ID: id, Payload: p}
}

func TestCommitmentFieldsFollowJavaScriptTruthinessAndString(t *testing.T) {
	for payload, want := range map[string]string{
		`{"Responsable":"Ana"}`:                     "Ana",
		`{"Responsable":0}`:                         "",
		`{"Responsable":""}`:                        "",
		`{"Responsable":false}`:                     "",
		`{"Responsable":null}`:                      "",
		`{"Responsable":[]}`:                        "",
		`{"Responsable":{}}`:                        "",
		`{"Responsable":true}`:                      "true",
		`{"Responsable":1.50}`:                      "1.5",
		`{"Responsable":1e21}`:                      "1e+21",
		`{"Responsable":123456789012345678901}`:     "123456789012345680000",
		`{"Responsable":1e-7}`:                      "1e-7",
		`{"Responsable":0.000001}`:                  "0.000001",
		`{"Responsable":-2.5e-10}`:                  "-2.5e-10",
		`{"Responsable":1e400}`:                     "Infinity",
		`{"Responsable":["a",1.0,null,{"x":"\n"}]}`: `["a",1,null,{"x":"\n"}]`,
		`{"Responsable": {"b": 1, "a": [1e400, "\u0001\"<"], "10": true, "2": null, "01": 0}}`: `{"2":null,"10":true,"b":1,"a":[null,"\u0001\"<"],"01":0}`,
	} {
		got := CommitmentsOf([]Record{record(t, "c", payload)})[0].Responsible
		if got != want {
			t.Errorf("%s: got %s, want %s", payload, got, want)
		}
	}
}

func TestOverviewJSONShapeWithoutRows(t *testing.T) {
	report := ManagementOverview(Input{ProjectID: "P-1", GeneratedAt: "2026-10-15T00:00:00Z", Today: "2026-10-15"})
	got, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"version":"2.8","project_id":"P-1","generated_at":"2026-10-15T00:00:00Z","metrics":{"digital_alerts":0,"high_priority_alerts":0,"pending_review":0,"total_actions":0,"active_actions":0,"overdue_actions":0,"completed_actions":0,"completion_percent":0,"average_progress":0,"registered_commitments":0,"overdue_commitments_explicit":0},"alerts_by_level":{},"actions_by_status":{},"actions_by_responsible":[],"critical_actions":[],"recent_alerts":[],"commitments":[],"methodology":"Indicadores descriptivos de registros por proyecto; las prioridades digitales no son probabilidades de conflicto.","limitations":["IRSA permanece independiente","Acceso restringido a usuarios autenticados con permiso sobre el proyecto activo","Compromisos vencidos contados únicamente cuando el estado lo indica expresamente","No hay verificación automática de contenido en redes sociales"]}`
	if string(got) != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestOverviewCountsAlertsActionsAndCommitments(t *testing.T) {
	reviewed := "2026-10-02T10:00:00Z"
	alerts := []AlertRow{
		{ID: "A1", CreatedAt: "2026-10-03T00:00:00Z", SourceURL: "https://example.org/1", SourceType: "web", Level: "Alta", Score: 80, Status: "Pendiente de verificación"},
		{ID: "A2", CreatedAt: "2026-10-02T00:00:00Z", Level: "Alta", Score: 70, Status: "Descartado", ReviewedAt: &reviewed},
		{ID: "A3", CreatedAt: "2026-10-01T00:00:00Z", Level: "Media", Score: 40, Status: "Corroborado"},
	}
	actions := []ActionRow{
		{ID: "X1", Responsible: "Beta", DueDate: "2026-01-01", Status: "Pendiente", Progress: 10},
		{ID: "X2", Responsible: "Alfa", DueDate: "2026-01-02", Status: "Completada", Progress: 100},
		{ID: "X3", Responsible: "Alfa", DueDate: "2026-12-01", Status: "En ejecución", Progress: 45},
		{ID: "X4", Responsible: "Beta", DueDate: "2026-01-03", Status: "Pendiente", Progress: 0},
		{ID: "X5", Responsible: "Gama", DueDate: "2026-01-04", Status: "Cancelada", Progress: 0},
		{ID: "X6", Responsible: "Delta", DueDate: "2026-01-05", Status: "Pendiente", Progress: 0},
	}
	commitments := []Commitment{{ID: "C1", Status: "VENCIDO"}, {ID: "C2", Status: "Pendiente"}}
	r := ManagementOverview(Input{ProjectID: "P", Today: "2026-06-01", Alerts: alerts, Actions: actions, Commitments: commitments})
	m := r.Metrics
	if m.DigitalAlerts != 3 || m.HighPriorityAlerts != 1 || m.PendingReview != 1 || m.TotalActions != 6 ||
		m.ActiveActions != 4 || m.OverdueActions != 3 || m.CompletedActions != 1 ||
		m.CompletionPercent != 16.7 || m.AverageProgress != 25.8 || m.RegisteredCommitments != 2 ||
		m.OverdueCommitmentsExplicit != 1 {
		t.Fatalf("metrics = %+v", m)
	}
	if r.AlertsByLevel["Alta"] != 2 || r.AlertsByLevel["Media"] != 1 || r.ActionsByStatus["Pendiente"] != 3 {
		t.Fatalf("counters = %v %v", r.AlertsByLevel, r.ActionsByStatus)
	}
	// Equal counts keep first-seen order (a stable sort over Map insertion order).
	want := []ResponsibleCount{{"Beta", 2, 2}, {"Alfa", 2, 0}, {"Gama", 1, 0}, {"Delta", 1, 1}}
	if !slices.Equal(r.ActionsByResponsible, want) {
		t.Fatalf("by responsible = %+v", r.ActionsByResponsible)
	}
	if len(r.RecentAlerts) != 3 || r.RecentAlerts[1].ReviewedAt == nil || r.RecentAlerts[0].ReviewedAt != nil {
		t.Fatalf("recent alerts = %+v", r.RecentAlerts)
	}
}

func TestOverviewTruncatesItsLists(t *testing.T) {
	var alerts []AlertRow
	var actions []ActionRow
	var commitments []Commitment
	for i := range 120 {
		id := string(rune('a'+i%26)) + string(rune('a'+i/26))
		alerts = append(alerts, AlertRow{ID: id})
		actions = append(actions, ActionRow{ID: id, Responsible: id, DueDate: "2020-01-01", Status: "Pendiente"})
		commitments = append(commitments, Commitment{ID: id})
	}
	r := ManagementOverview(Input{Today: "2026-01-01", Alerts: alerts, Actions: actions, Commitments: commitments})
	if len(r.RecentAlerts) != 15 || len(r.CriticalActions) != 20 || len(r.ActionsByResponsible) != 30 || len(r.Commitments) != 100 {
		t.Fatalf("lengths %d %d %d %d", len(r.RecentAlerts), len(r.CriticalActions), len(r.ActionsByResponsible), len(r.Commitments))
	}
}

func TestCSVBytes(t *testing.T) {
	report := ManagementOverview(Input{
		ProjectID: "PRJ-1", GeneratedAt: "2026-10-15T12:00:00Z", Today: "2026-10-15",
		Actions: []ActionRow{
			{ID: "1", Title: "=SUM(A1)", Responsible: `Equipo "A", norte`, DueDate: "2026-10-01", Status: "Pendiente", Progress: 0},
			{ID: "2", Title: "Línea\nnueva", Responsible: "-x", DueDate: "2026-10-02", Status: "En ejecución", Progress: 100},
		},
	})
	want := "\ufeffSIPGES RC 2.8,Resumen gerencial,PRJ-1,2026-10-15T12:00:00Z\r\n" +
		"Indicador,Valor\r\n" +
		"digital_alerts,0\r\nhigh_priority_alerts,0\r\npending_review,0\r\ntotal_actions,2\r\n" +
		"active_actions,2\r\noverdue_actions,2\r\ncompleted_actions,0\r\ncompletion_percent,0.0\r\n" +
		"average_progress,50.0\r\nregistered_commitments,0\r\noverdue_commitments_explicit,0\r\n" +
		"\r\n" +
		"Acciones críticas,Responsable,Plazo,Estado,Avance (%)\r\n" +
		"'=SUM(A1),\"Equipo \"\"A\"\", norte\",2026-10-01,Pendiente,0\r\n" +
		"\"Línea\nnueva\",'-x,2026-10-02,En ejecución,100\r\n" +
		"\r\n" +
		"Nota metodológica,Indicadores descriptivos de registros por proyecto; las prioridades digitales no son probabilidades de conflicto.\r\n"
	if got := ManagementCSV(report); got != want {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
}

func TestCSVKeepsIntegersWithoutActions(t *testing.T) {
	got := ManagementCSV(ManagementOverview(Input{ProjectID: "P", GeneratedAt: "g", Today: "2026-01-01"}))
	for _, line := range []string{"\r\ncompletion_percent,0\r\n", "\r\naverage_progress,0\r\n"} {
		if !strings.Contains(got, line) {
			t.Errorf("missing %q in %q", line, got)
		}
	}
	got = ManagementCSV(ManagementOverview(Input{Today: "2026-01-01", Actions: []ActionRow{
		{Status: "Completada", Progress: 33}, {Status: "Pendiente", Progress: 0}, {Status: "Pendiente", Progress: 0},
	}}))
	for _, line := range []string{"\r\ncompletion_percent,33.3\r\n", "\r\naverage_progress,11.0\r\n"} {
		if !strings.Contains(got, line) {
			t.Errorf("missing %q in %q", line, got)
		}
	}
}

package domain_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/domain"
)

// Synthetic plans; "today" is 2026-11-03 in every case.
const today = "2026-11-03"

var since = time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)

func plan(status domain.ActionStatus, due string, progress int, block *domain.ActionBlock) domain.PreventiveAction {
	return domain.PreventiveAction{ID: "PREV-" + due, Status: status, DueDate: due, Progress: progress, Block: block}
}

func TestRoundHalfEven(t *testing.T) {
	// Ported from packages/kernel roundHalfEven: ties go to the even neighbour.
	for _, c := range []struct{ in, want float64 }{
		{0.25, 0.2}, {0.35, 0.4}, {17.6, 17.6}, {33.33333, 33.3}, {66.66667, 66.7}, {2.5, 2.5}, {0, 0},
	} {
		if got := domain.RoundHalfEven(c.in, 1); got != c.want {
			t.Errorf("RoundHalfEven(%v, 1) = %v, want %v", c.in, got, c.want)
		}
	}
	if got := domain.RoundHalfEven(2.5, 0); got != 2 {
		t.Errorf("RoundHalfEven(2.5, 0) = %v, want 2", got)
	}
	if got := domain.RoundHalfEven(3.5, 0); got != 4 {
		t.Errorf("RoundHalfEven(3.5, 0) = %v, want 4", got)
	}
}

func TestOverdueOnlyWhenActiveAndDueBeforeToday(t *testing.T) {
	for _, c := range []struct {
		action domain.PreventiveAction
		want   bool
	}{
		{plan(domain.StatusPending, "2026-11-02", 0, nil), true},
		{plan(domain.StatusInProgress, "2026-11-03", 10, nil), false}, // due today is not late
		{plan(domain.StatusCompleted, "2020-01-01", 100, nil), false},
		{plan(domain.StatusCancelled, "2020-01-01", 0, nil), false},
	} {
		if got := domain.IsOverdue(c.action, today); got != c.want {
			t.Errorf("IsOverdue(%s %s) = %v", c.action.Status, c.action.DueDate, got)
		}
	}
}

func TestSummary(t *testing.T) {
	actions := []domain.PreventiveAction{
		plan(domain.StatusPending, "2020-01-15", 0, nil),
		plan(domain.StatusCompleted, "2020-01-15", 100, nil),
		plan(domain.StatusCancelled, "2099-01-01", 0, nil),
		plan(domain.StatusInProgress, "2099-01-01", 33, nil),
		plan(domain.StatusInProgress, "2099-01-01", 40, nil),
		plan(domain.StatusInProgress, "2025-01-01", 1, nil),
	}
	got, _ := json.Marshal(domain.NewSummary("PRJ-SECHURA", actions, today))
	want := `{"project_id":"PRJ-SECHURA","total":6,"active":4,"overdue":2,"completed":1,` +
		`"completion_percent":16.7,"average_progress":29,"irsa_modified":false,` +
		`"notice":"Métricas operativas de acciones; no equivalen a una disminución validada del riesgo social."}`
	if string(got) != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	empty, _ := json.Marshal(domain.NewSummary("P", nil, today))
	if want := `{"project_id":"P","total":0,"active":0,"overdue":0,"completed":0,"completion_percent":0,` +
		`"average_progress":0,"irsa_modified":false,"notice":"Métricas operativas de acciones; no equivalen a una disminución validada del riesgo social."}`; string(empty) != want {
		t.Fatalf("empty: %s", empty)
	}
}

func TestSituationRoom(t *testing.T) {
	community := &domain.ActionBlock{By: "Comunidad", Reason: "Asamblea", Since: since}
	authority := &domain.ActionBlock{By: "Autoridad", Since: since}
	actions := []domain.PreventiveAction{
		plan(domain.StatusInProgress, "2020-01-01", 10, authority), // blocked wins over overdue
		plan(domain.StatusPending, "2020-01-02", 0, nil),           // overdue
		plan(domain.StatusInProgress, "2099-01-01", 50, community), // blocked
		plan(domain.StatusInProgress, "2099-01-02", 20, authority), // blocked
		plan(domain.StatusCancelled, "2020-01-03", 0, community),   // closed: ignored
		plan(domain.StatusInProgress, "2099-01-03", 70, nil),       // moving
		plan(domain.StatusPending, today, 0, nil),                  // moving: due today
		plan(domain.StatusCompleted, "2020-01-04", 100, nil),       // closed: ignored
	}
	room := domain.NewSituationRoom(actions, today)
	if len(room.Blocked) != 3 || room.Blocked[0].DueDate != "2020-01-01" || room.Blocked[2].DueDate != "2099-01-02" {
		t.Fatalf("blocked = %+v", room.Blocked)
	}
	if len(room.Overdue) != 1 || room.Overdue[0].DueDate != "2020-01-02" {
		t.Fatalf("overdue = %+v", room.Overdue)
	}
	if room.Moving != 2 {
		t.Fatalf("moving = %d", room.Moving)
	}
	// Keys in first-seen order, as the JavaScript object the TypeScript API returns.
	if got, _ := json.Marshal(room.BlockedByCount); string(got) != `{"Autoridad":2,"Comunidad":1}` {
		t.Fatalf("blocked_by_count = %s", got)
	}
	if got, _ := json.Marshal(domain.NewSituationRoom(nil, today).BlockedByCount); string(got) != `{}` {
		t.Fatalf("empty blocked_by_count = %s", got)
	}
}

// Package domain is the Go port of apps/api/src/contexts/management/domain/overview.ts: the
// per-project management center (app.py:2224-2270, RC 2.8). Descriptive counts only.
package domain

import (
	"slices"
	"strings"
)

// AlertRow is an alert as the management read model sees it; times are `YYYY-MM-DDTHH:MM:SSZ`.
type AlertRow struct {
	ID         string
	CreatedAt  string
	SourceURL  string
	SourceType string
	Level      string
	Score      int64
	Status     string
	ReviewedAt *string
}

// ActionRow is a preventive action as the management read model sees it.
type ActionRow struct {
	ID          string
	AlertID     string
	Title       string
	Responsible string
	DueDate     string
	Status      string
	Progress    int64
	UpdatedAt   string
}

// Record is a stored `Compromisos` record.
type Record struct {
	ID      string
	Payload Payload
}

// Commitment is overview.ts `Commitment`, also its JSON form.
type Commitment struct {
	ID          string `json:"id"`
	Responsible string `json:"responsible"`
	Status      string `json:"status"`
	DueDate     string `json:"due_date"`
}

// CommitmentsOf is commitmentsOf: the tenant is the project (S13), so `Proyecto_ID` is not
// re-checked.
func CommitmentsOf(records []Record) []Commitment {
	out := make([]Commitment, 0, len(records))
	for _, r := range records {
		pick := func(key string) string {
			if v, _ := r.Payload.Get(key); truthy(v) {
				return str(v)
			}
			return ""
		}
		out = append(out, Commitment{
			ID:          r.ID,
			Responsible: pick("Responsable"), //nolint:misspell // Spanish payload key
			Status:      pick("Estado"),
			DueDate:     RecordDueDate(r.Payload),
		})
	}
	return out
}

// Input is managementOverview's argument: alerts newest first, actions by due date ascending.
type Input struct {
	ProjectID   string
	GeneratedAt string
	Today       string
	Alerts      []AlertRow
	Actions     []ActionRow
	Commitments []Commitment
}

// Metrics is the `metrics` object, in overview.ts key order (the CSV lists them in it).
type Metrics struct {
	DigitalAlerts              int     `json:"digital_alerts"`
	HighPriorityAlerts         int     `json:"high_priority_alerts"`
	PendingReview              int     `json:"pending_review"`
	TotalActions               int     `json:"total_actions"`
	ActiveActions              int     `json:"active_actions"`
	OverdueActions             int     `json:"overdue_actions"`
	CompletedActions           int     `json:"completed_actions"`
	CompletionPercent          float64 `json:"completion_percent"`
	AverageProgress            float64 `json:"average_progress"`
	RegisteredCommitments      int     `json:"registered_commitments"`
	OverdueCommitmentsExplicit int     `json:"overdue_commitments_explicit"`
}

type metric struct {
	key   string
	value float64
	float bool // a Python float once there are actions
}

func (m Metrics) entries() []metric {
	return []metric{
		{"digital_alerts", float64(m.DigitalAlerts), false},
		{"high_priority_alerts", float64(m.HighPriorityAlerts), false},
		{"pending_review", float64(m.PendingReview), false},
		{"total_actions", float64(m.TotalActions), false},
		{"active_actions", float64(m.ActiveActions), false},
		{"overdue_actions", float64(m.OverdueActions), false},
		{"completed_actions", float64(m.CompletedActions), false},
		{"completion_percent", m.CompletionPercent, true},
		{"average_progress", m.AverageProgress, true},
		{"registered_commitments", float64(m.RegisteredCommitments), false},
		{"overdue_commitments_explicit", float64(m.OverdueCommitmentsExplicit), false},
	}
}

// ResponsibleCount is one `actions_by_responsible` entry.
type ResponsibleCount struct {
	Name    string `json:"name"`
	Total   int    `json:"total"`
	Overdue int    `json:"overdue"`
}

// ActionJSON is overview.ts `actionJson`.
type ActionJSON struct {
	ID          string `json:"id"`
	AlertID     string `json:"alert_id"`
	Title       string `json:"title"`
	Responsible string `json:"responsible"`
	DueDate     string `json:"due_date"`
	Status      string `json:"status"`
	Progress    int64  `json:"progress"`
	UpdatedAt   string `json:"updated_at"`
}

// AlertJSON is overview.ts `alertJson`.
type AlertJSON struct {
	ID         string  `json:"id"`
	CreatedAt  string  `json:"created_at"`
	SourceURL  string  `json:"source_url"`
	SourceType string  `json:"source_type"`
	Level      string  `json:"level"`
	Score      int64   `json:"score"`
	Status     string  `json:"status"`
	ReviewedAt *string `json:"reviewed_at"`
}

// Overview is the JSON of GET /system/management/overview.
type Overview struct {
	Version              string             `json:"version"`
	ProjectID            string             `json:"project_id"`
	GeneratedAt          string             `json:"generated_at"`
	Metrics              Metrics            `json:"metrics"`
	AlertsByLevel        map[string]int     `json:"alerts_by_level"`
	ActionsByStatus      map[string]int     `json:"actions_by_status"`
	ActionsByResponsible []ResponsibleCount `json:"actions_by_responsible"`
	CriticalActions      []ActionJSON       `json:"critical_actions"`
	RecentAlerts         []AlertJSON        `json:"recent_alerts"`
	Commitments          []Commitment       `json:"commitments"`
	Methodology          string             `json:"methodology"`
	Limitations          []string           `json:"limitations"`
}

// Methodology is the report's methodological note.
const Methodology = "Indicadores descriptivos de registros por proyecto; las prioridades digitales no son probabilidades de conflicto." //nolint:misspell // Spanish text kept verbatim from the TypeScript API

// counter is overview.ts `counter`: counts in first-seen (Map insertion) order.
type counter struct {
	order  []string
	counts map[string]int
}

func count(values []string) counter {
	c := counter{counts: map[string]int{}}
	for _, v := range values {
		if _, seen := c.counts[v]; !seen {
			c.order = append(c.order, v)
		}
		c.counts[v]++
	}
	return c
}

func mapOf[T any](rows []T, field func(T) string) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = field(r)
	}
	return out
}

func filter[T any](rows []T, keep func(T) bool) []T {
	out := []T{}
	for _, r := range rows {
		if keep(r) {
			out = append(out, r)
		}
	}
	return out
}

func head[T any](rows []T, n int) []T { return rows[:min(n, len(rows))] }

// ManagementOverview is managementOverview. app.py's "Sin autenticación empresarial"
// limitation no longer holds and is replaced.
func ManagementOverview(in Input) Overview {
	alerts, actions, commitments, today := in.Alerts, in.Actions, in.Commitments, in.Today
	ongoing := filter(actions, func(r ActionRow) bool { return !IsTerminalStatus(r.Status) })
	late := filter(ongoing, func(r ActionRow) bool {
		return IsValidCalendarDate(r.DueDate) && IsValidCalendarDate(today) && r.DueDate < today
	})
	pending := filter(alerts, func(r AlertRow) bool { return r.Status == "Pendiente de verificación" })
	high := filter(alerts, func(r AlertRow) bool { return r.Level == "Alta" && r.Status != "Descartado" })
	critical := slices.Clone(late)
	slices.SortStableFunc(critical, func(a, b ActionRow) int { return strings.Compare(a.DueDate, b.DueDate) })
	critical = head(critical, 20)
	completed := len(filter(actions, func(r ActionRow) bool { return IsCompletedStatus(r.Status) }))

	byResponsible := count(mapOf(actions, func(r ActionRow) string { return r.Responsible }))
	names := slices.Clone(byResponsible.order)
	slices.SortStableFunc(names, func(a, b string) int { return byResponsible.counts[b] - byResponsible.counts[a] })
	responsible := []ResponsibleCount{}
	for _, name := range head(names, 30) {
		overdue := len(filter(late, func(r ActionRow) bool { return r.Responsible == name }))
		responsible = append(responsible, ResponsibleCount{Name: name, Total: byResponsible.counts[name], Overdue: overdue})
	}

	metrics := Metrics{
		DigitalAlerts:         len(alerts),
		HighPriorityAlerts:    len(high),
		PendingReview:         len(pending),
		TotalActions:          len(actions),
		ActiveActions:         len(ongoing),
		OverdueActions:        len(late),
		CompletedActions:      completed,
		RegisteredCommitments: len(commitments),
		OverdueCommitmentsExplicit: len(filter(commitments, func(c Commitment) bool {
			return strings.Contains(jsLowerCase(c.Status), "vencid")
		})),
	}
	if n := float64(len(actions)); n > 0 {
		metrics.CompletionPercent = RoundHalfEven(100*float64(completed)/n, 1)
		var sum float64
		for _, a := range actions {
			sum += float64(a.Progress)
		}
		metrics.AverageProgress = RoundHalfEven(sum/n, 1)
	}

	criticalJSON := make([]ActionJSON, 0, len(critical))
	for _, a := range critical {
		criticalJSON = append(criticalJSON, ActionJSON(a))
	}
	recent := make([]AlertJSON, 0, min(15, len(alerts)))
	for _, a := range head(alerts, 15) {
		recent = append(recent, AlertJSON(a))
	}
	return Overview{
		Version:              "2.8",
		ProjectID:            in.ProjectID,
		GeneratedAt:          in.GeneratedAt,
		Metrics:              metrics,
		AlertsByLevel:        count(mapOf(alerts, func(r AlertRow) string { return r.Level })).counts,
		ActionsByStatus:      count(mapOf(actions, func(r ActionRow) string { return r.Status })).counts,
		ActionsByResponsible: responsible,
		CriticalActions:      criticalJSON,
		RecentAlerts:         recent,
		Commitments:          append([]Commitment{}, head(commitments, 100)...),
		Methodology:          Methodology,
		Limitations: []string{
			"IRSA permanece independiente",
			"Acceso restringido a usuarios autenticados con permiso sobre el proyecto activo",
			"Compromisos vencidos contados únicamente cuando el estado lo indica expresamente",
			"No hay verificación automática de contenido en redes sociales",
		},
	}
}

// jsLowerCase is String.prototype.toLowerCase where it differs from strings.ToLower in a way
// that can matter here: U+0130 (İ) becomes "i̇", so "VENCİDO" does not contain "vencid".
func jsLowerCase(s string) string {
	return strings.ToLower(strings.ReplaceAll(s, "İ", "i̇"))
}

// Package domain holds the preventive action plans of
// apps/api/src/contexts/prevention/domain/actions.ts (app.py:2133-2216, RC 2.7): plans that
// follow verified alerts, their summary and the situation room. Only the read side is ported.
package domain

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"time"
)

// ActionStatus is one of the four plan states.
type ActionStatus string

// The plan states of ACTION_STATUSES.
const (
	StatusPending    ActionStatus = "Pendiente"
	StatusInProgress ActionStatus = "En ejecución"
	StatusCompleted  ActionStatus = "Completada"
	StatusCancelled  ActionStatus = "Cancelada"
)

// DecisionReceipt is the evidence file behind a decision, frozen with its hash (ADR 0023).
type DecisionReceipt struct {
	AttachmentID string
	FileName     string
	SHA256       string
}

// ActionLogEntry is one entry of a plan's history.
type ActionLogEntry struct {
	ID          string
	ActionID    string
	CreatedAt   time.Time
	Status      ActionStatus
	Progress    int
	Note        string
	EvidenceURL *string
	// DecidedBy is nil on entries written before receipts existed.
	DecidedBy *string
	Receipt   *DecisionReceipt
}

// ActionBlock is who a plan is waiting on (ADR 0024 §2).
type ActionBlock struct {
	By     string
	Reason string
	Since  time.Time
}

// PreventiveAction is one plan with its history, newest entry first.
type PreventiveAction struct {
	ID          string
	ProjectID   string
	AlertID     string
	Title       string
	Responsible string
	// DueDate is a calendar date, YYYY-MM-DD.
	DueDate     string
	Description string
	Status      ActionStatus
	Progress    int
	CreatedAt   time.Time
	UpdatedAt   time.Time
	History     []ActionLogEntry
	Block       *ActionBlock
}

// IsActive is isActive: neither completed nor cancelled.
func IsActive(a PreventiveAction) bool {
	return a.Status != StatusCompleted && a.Status != StatusCancelled
}

// IsOverdue is isOverdue: still active and due strictly before today (YYYY-MM-DD compares as text).
func IsOverdue(a PreventiveAction, today string) bool {
	return IsActive(a) && a.DueDate < today
}

// RoundHalfEven is roundHalfEven of packages/kernel, with the same float64 steps.
func RoundHalfEven(value float64, digits int) float64 {
	factor := math.Pow(10, float64(digits))
	scaled := value * factor
	floor := math.Floor(scaled)
	diff := scaled - floor
	rounded := floor
	switch {
	case diff > 0.5:
		rounded = floor + 1
	case diff == 0.5 && math.Mod(floor, 2) != 0:
		rounded = floor + 1
	}
	return rounded / factor
}

func completionPercent(actions []PreventiveAction) float64 {
	if len(actions) == 0 {
		return 0
	}
	completed := 0
	for _, a := range actions {
		if a.Status == StatusCompleted {
			completed++
		}
	}
	return RoundHalfEven(float64(completed*100)/float64(len(actions)), 1)
}

func averageProgress(actions []PreventiveAction) float64 {
	if len(actions) == 0 {
		return 0
	}
	total := 0
	for _, a := range actions {
		total += a.Progress
	}
	return RoundHalfEven(float64(total)/float64(len(actions)), 1)
}

// SummaryNotice is the fixed notice of preventionSummary.
const SummaryNotice = "Métricas operativas de acciones; no equivalen a una disminución validada del riesgo social."

// Summary is the body of GET /system/prevention/summary.
type Summary struct {
	ProjectID         string  `json:"project_id"`
	Total             int     `json:"total"`
	Active            int     `json:"active"`
	Overdue           int     `json:"overdue"`
	Completed         int     `json:"completed"`
	CompletionPercent float64 `json:"completion_percent"`
	AverageProgress   float64 `json:"average_progress"`
	IRSAModified      bool    `json:"irsa_modified"`
	Notice            string  `json:"notice"`
}

// NewSummary is preventionSummary.
func NewSummary(projectID string, actions []PreventiveAction, today string) Summary {
	s := Summary{
		ProjectID:         projectID,
		Total:             len(actions),
		CompletionPercent: completionPercent(actions),
		AverageProgress:   averageProgress(actions),
		Notice:            SummaryNotice,
	}
	for _, a := range actions {
		if IsActive(a) {
			s.Active++
		}
		if IsOverdue(a, today) {
			s.Overdue++
		}
		if a.Status == StatusCompleted {
			s.Completed++
		}
	}
	return s
}

// BlockerCount counts blocked plans per party, keeping the first-seen key order of the
// JavaScript object the TypeScript API returns.
type BlockerCount struct {
	keys   []string
	counts map[string]int
}

func (c *BlockerCount) add(by string) {
	if c.counts == nil {
		c.counts = map[string]int{}
	}
	if _, seen := c.counts[by]; !seen {
		c.keys = append(c.keys, by)
	}
	c.counts[by]++
}

// MarshalJSON writes the counts as an object in first-seen order; {} when there are none.
func (c BlockerCount) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range c.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		key, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		b.Write(key)
		b.WriteByte(':')
		b.WriteString(strconv.Itoa(c.counts[k]))
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// SituationRoom is situationRoom: active plans waiting on someone, overdue ones that wait on
// nobody, and how many are moving normally.
type SituationRoom struct {
	Blocked        []PreventiveAction
	Overdue        []PreventiveAction
	Moving         int
	BlockedByCount BlockerCount
}

// NewSituationRoom is situationRoom.
func NewSituationRoom(actions []PreventiveAction, today string) SituationRoom {
	room := SituationRoom{Blocked: []PreventiveAction{}, Overdue: []PreventiveAction{}}
	active := 0
	for _, a := range actions {
		if !IsActive(a) {
			continue
		}
		active++
		switch {
		case a.Block != nil:
			room.Blocked = append(room.Blocked, a)
			room.BlockedByCount.add(a.Block.By)
		case IsOverdue(a, today):
			room.Overdue = append(room.Overdue, a)
		}
	}
	room.Moving = active - len(room.Blocked) - len(room.Overdue)
	return room
}

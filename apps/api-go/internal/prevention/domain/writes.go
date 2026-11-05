package domain

import (
	"regexp"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/zod"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// UpdateError is why a plan cannot change, or was not created; "" is none.
type UpdateError string

// The kinds of CreateError and UpdateError of prevention-service.ts.
const (
	ErrAlertMissing      UpdateError = "alert_missing"
	ErrAlertUnverified   UpdateError = "alert_unverified"
	ErrStatus            UpdateError = "status"
	ErrCompletedProgress UpdateError = "completed_progress"
	ErrPendingProgress   UpdateError = "pending_progress"
	ErrEvidenceURL       UpdateError = "evidence_url"
	ErrMissing           UpdateError = "missing"
	ErrReactivate        UpdateError = "reactivate"
	ErrNoteRequired      UpdateError = "note_required"
	ErrEvidenceRequired  UpdateError = "evidence_required"
	ErrEvidenceMissing   UpdateError = "evidence_missing"
	ErrBlocker           UpdateError = "blocker"
)

var blockers = []string{"Comunidad", "Autoridad", "Área interna", "Contratista", "Otro"}

// IsBlocker is isBlocker.
func IsBlocker(value string) bool {
	for _, b := range blockers {
		if value == b {
			return true
		}
	}
	return false
}

// IsActionable is whether a plan may follow an alert in this status: verified by a person first
// (app.py:2163-2167).
func IsActionable(alertStatus string) bool {
	return alertStatus == "Corroborado" || alertStatus == "En seguimiento"
}

// ActionUpdate is the body of PATCH /system/prevention/actions/:id after parsing.
type ActionUpdate struct {
	Status   string
	Progress int
	Note     string
	// EvidenceURL and EvidenceAttachmentID are "" when absent.
	EvidenceURL          string
	EvidenceAttachmentID string
	// BlockedBy is who the action waits on: "" clears it, nil leaves it.
	BlockedBy     *string
	BlockedReason *string
}

// BlockChange is the blocker part of an update: Change false leaves it as it was, To nil clears it.
type BlockChange struct {
	Change bool
	To     *ActionBlock
}

// evidenceScheme is /^https?:\/\//i: without the u flag, /i folds only ASCII here.
var evidenceScheme = regexp.MustCompile(`^[hH][tT][tT][pP][sS]?://`)

// CheckUpdate is checkUpdate: the checks that need no stored state, in app.py order.
func CheckUpdate(u ActionUpdate) (ActionStatus, UpdateError) {
	status := ActionStatus(u.Status)
	switch {
	case status != StatusPending && status != StatusInProgress && status != StatusCompleted && status != StatusCancelled:
		return "", ErrStatus
	case status == StatusCompleted && u.Progress != 100:
		return "", ErrCompletedProgress
	case status == StatusPending && u.Progress > 0:
		return "", ErrPendingProgress
	case u.EvidenceURL != "" && !evidenceScheme.MatchString(u.EvidenceURL):
		return "", ErrEvidenceURL
	}
	return status, ""
}

// CheckTransition is checkTransition: a cancelled plan stays cancelled; closing needs a reason.
func CheckTransition(current, next ActionStatus, note string) UpdateError {
	if current == StatusCancelled && next != StatusCancelled {
		return ErrReactivate
	}
	if (next == StatusCompleted || next == StatusCancelled) && records.TrimJS(note) == "" {
		return ErrNoteRequired
	}
	return ""
}

// CheckReceipt is checkReceipt: completing a plan claims the risk was addressed, so it needs an
// attached evidence file.
func CheckReceipt(status ActionStatus, attachmentID string) UpdateError {
	if status == StatusCompleted && attachmentID == "" {
		return ErrEvidenceRequired
	}
	return ""
}

// NextBlock is the update's blocker: a closed plan waits on nobody; "" clears it; absent leaves it.
// blockedBy is already trimmed and, when not "", a blocker.
func NextBlock(status ActionStatus, blockedBy, reason *string, now time.Time) BlockChange {
	switch {
	case status == StatusCompleted || status == StatusCancelled:
		return BlockChange{Change: true}
	case blockedBy == nil:
		return BlockChange{}
	case *blockedBy == "":
		return BlockChange{Change: true}
	}
	block := ActionBlock{By: *blockedBy, Since: now}
	if reason != nil {
		block.Reason = records.TrimJS(*reason)
	}
	return BlockChange{Change: true, To: &block}
}

// AuditDetail is the UPDATE audit detail of the SQL store: the status, the note's first 200 code
// points and the short hash of the receipt.
func AuditDetail(status ActionStatus, note string, receipt *DecisionReceipt) string {
	runes := []rune(records.WellFormed(note))
	if len(runes) > 200 {
		runes = runes[:200]
	}
	detail := string(status) + ": " + string(runes)
	if receipt != nil {
		sha := receipt.SHA256
		if len(sha) > 12 {
			sha = sha[:12]
		}
		detail += " · sha256 " + sha
	}
	return detail
}

var calendarDate = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)

// IsCalendarDate is isCalendarDate: a real calendar date in YYYY-MM-DD form.
func IsCalendarDate(value string) bool {
	if !calendarDate.MatchString(value) {
		return false
	}
	_, err := time.Parse(time.DateOnly, value)
	return err == nil
}

// CreateInput is the body of POST /system/prevention/actions after parsing.
type CreateInput struct {
	AlertID, Title, Responsible, DueDate, Description string
}

// optionalText is .optional() or .default(""): absent reads as "".
func optionalText(s zod.Str, v any) (string, zod.Issues) {
	if zod.IsUndefined(v) {
		return "", nil
	}
	return s.Parse(v)
}

// ParseCreate is CreateBody.safeParse of prevention-routes.ts.
func ParseCreate(body any) (CreateInput, []records.Issue) {
	var p zod.Issues
	o, ok := zod.Object(body, &p)
	if !ok {
		return CreateInput{}, zod.ToIssues(p, body)
	}
	var in CreateInput
	_, child := optionalText(zod.Str{Min: 1, Max: 120}, zod.Field(o, "project_id"))
	p.Merge("project_id", child)
	in.AlertID, child = zod.Str{Min: 1, Max: 80}.Parse(zod.Field(o, "alert_id"))
	p.Merge("alert_id", child)
	in.Title, child = zod.Str{Min: 5, Max: 200}.Parse(zod.Field(o, "title"))
	p.Merge("title", child)
	in.Responsible, child = zod.Str{Min: 2, Max: 150}.Parse(zod.Field(o, "responsible"))
	p.Merge("responsible", child)
	in.DueDate, child = zod.Str{}.Parse(zod.Field(o, "due_date"))
	if !child.Aborted() && !IsCalendarDate(in.DueDate) {
		child.AddContinue("custom", "Input should be a valid date")
	}
	p.Merge("due_date", child)
	in.Description, child = optionalText(zod.Str{Max: 2000}, zod.Field(o, "description"))
	p.Merge("description", child)
	if len(p) > 0 {
		return CreateInput{}, zod.ToIssues(p, body)
	}
	return in, nil
}

// optionalPointer is .optional() that must stay distinct from "": absent reads as nil.
func optionalPointer(s zod.Str, v any) (*string, zod.Issues) {
	if zod.IsUndefined(v) {
		return nil, nil
	}
	text, p := s.Parse(v)
	return &text, p
}

// ParseUpdate is UpdateBody.safeParse of prevention-routes.ts.
func ParseUpdate(body any) (ActionUpdate, []records.Issue) {
	var p zod.Issues
	o, ok := zod.Object(body, &p)
	if !ok {
		return ActionUpdate{}, zod.ToIssues(p, body)
	}
	var in ActionUpdate
	var child zod.Issues
	in.Status, child = zod.Str{}.Parse(zod.Field(o, "status"))
	p.Merge("status", child)
	progress, child := zod.Num{Int: true, Min: zod.Bound(0), Max: zod.Bound(100)}.Parse(zod.Field(o, "progress"))
	in.Progress = int(progress)
	p.Merge("progress", child)
	in.Note, child = optionalText(zod.Str{Max: 2000}, zod.Field(o, "note"))
	p.Merge("note", child)
	in.EvidenceURL, child = optionalText(zod.Str{Max: 2000}, zod.Field(o, "evidence_url"))
	p.Merge("evidence_url", child)
	in.EvidenceAttachmentID, child = optionalText(zod.Str{Max: 120}, zod.Field(o, "evidence_attachment_id"))
	p.Merge("evidence_attachment_id", child)
	in.BlockedBy, child = optionalPointer(zod.Str{Max: 40}, zod.Field(o, "blocked_by"))
	p.Merge("blocked_by", child)
	in.BlockedReason, child = optionalPointer(zod.Str{Max: 500}, zod.Field(o, "blocked_reason"))
	p.Merge("blocked_reason", child)
	if len(p) > 0 {
		return ActionUpdate{}, zod.ToIssues(p, body)
	}
	return in, nil
}

// TrimmedBlockedBy is update.blockedBy?.trim().
func TrimmedBlockedBy(v *string) *string {
	if v == nil {
		return nil
	}
	s := records.TrimJS(*v)
	return &s
}

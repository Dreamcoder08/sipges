// Package application is apps/api/src/contexts/prevention/application/prevention-service.ts: the
// scope's plans, their summary and the situation room, and creating and updating plans.
package application

import (
	"context"
	"strings"
	"time"

	kernel "github.com/Dreamcoder08/sipges/apps/api-go/internal/management/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/domain"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// maxActionID is the longest id a plan can have, in UTF-16 code units.
const maxActionID = 80

// NewAction is a plan to insert: the store sets it Pendiente at 0%.
type NewAction struct {
	ID, ProjectID, AlertID, Title, Responsible, DueDate, Description string
	CreatedAt                                                        time.Time
}

// ActionChange is an update with its log entry.
type ActionChange struct {
	ID          string
	CreatedAt   time.Time
	Status      domain.ActionStatus
	Progress    int
	Note        string
	EvidenceURL string
	DecidedBy   string
	Receipt     *domain.DecisionReceipt
	Block       domain.BlockChange
}

// Guard runs on the row locked for update and may refuse the change.
type Guard func(current domain.PreventiveAction) domain.UpdateError

// ActionStore holds the plans of one project inside its tenant.
type ActionStore interface {
	List(ctx context.Context, tenantID, projectID string) ([]domain.PreventiveAction, error)
	// Create inserts the plan, its first log entry and the CREATE audit row in one transaction.
	Create(ctx context.Context, tenantID string, action NewAction, logID string) (domain.PreventiveAction, error)
	// Update applies the change with its log entry and UPDATE audit row in one transaction. The
	// error kind is the guard's, or ErrMissing when the plan is not the tenant's.
	Update(ctx context.Context, tenantID, id string, guard Guard, change ActionChange) (domain.PreventiveAction, domain.UpdateError, error)
}

// AlertLookup reads the status of a territorial alert of the scope (Digital Intelligence).
type AlertLookup interface {
	// Status is nil when the alert is missing or belongs to another project.
	Status(ctx context.Context, scope tenancy.Scope, alertID string) (*string, error)
}

// EvidenceLookup reads an evidence file of the scope (Evidence).
type EvidenceLookup interface {
	// Find is nil when the file is missing.
	Find(ctx context.Context, scope tenancy.Scope, attachmentID string) (*domain.DecisionReceipt, error)
}

// Service answers the prevention routes.
type Service struct {
	Store    ActionStore
	Alerts   AlertLookup
	Evidence EvidenceLookup
	// RandomHex returns that many upper-case random hexadecimal digits.
	RandomHex func(length int) string
	// Now is the clock that decides "today" (Lima) for the overdue rule; nil means time.Now.
	Now func() time.Time
}

func (s Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Today is today(): limaToday, the calendar day in Peru, YYYY-MM-DD.
func (s Service) Today() string { return kernel.LimaToday(s.now()) }

// Create is create: a plan follows an alert of the scope a person verified.
func (s Service) Create(ctx context.Context, scope tenancy.Scope, in domain.CreateInput) (domain.PreventiveAction, domain.UpdateError, error) {
	status, err := s.Alerts.Status(ctx, scope, in.AlertID)
	switch {
	case err != nil:
		return domain.PreventiveAction{}, "", err
	case status == nil:
		return domain.PreventiveAction{}, domain.ErrAlertMissing, nil
	case !domain.IsActionable(*status):
		return domain.PreventiveAction{}, domain.ErrAlertUnverified, nil
	}
	action, err := s.Store.Create(ctx, scope.TenantID(), NewAction{
		ID: "PREV-" + s.RandomHex(12), ProjectID: scope.ProjectID, AlertID: in.AlertID, Title: in.Title,
		Responsible: in.Responsible, DueDate: in.DueDate, Description: in.Description,
		CreatedAt: s.now().Truncate(time.Millisecond),
	}, strings.ToLower(s.RandomHex(32)))
	return action, "", err
}

// Update is update: the checks in their TypeScript order, then the change under the row lock.
func (s Service) Update(ctx context.Context, scope tenancy.Scope, id string, u domain.ActionUpdate, actor string) (domain.PreventiveAction, domain.UpdateError, error) {
	status, refused := domain.CheckUpdate(u)
	if refused != "" {
		return domain.PreventiveAction{}, refused, nil
	}
	if records.Units16(id) > maxActionID {
		return domain.PreventiveAction{}, domain.ErrMissing, nil
	}
	attachmentID := records.TrimJS(u.EvidenceAttachmentID)
	if refused := domain.CheckReceipt(status, attachmentID); refused != "" {
		return domain.PreventiveAction{}, refused, nil
	}
	var receipt *domain.DecisionReceipt
	if attachmentID != "" {
		var err error
		if receipt, err = s.Evidence.Find(ctx, scope, attachmentID); err != nil {
			return domain.PreventiveAction{}, "", err
		}
		if receipt == nil {
			return domain.PreventiveAction{}, domain.ErrEvidenceMissing, nil
		}
	}
	blockedBy := domain.TrimmedBlockedBy(u.BlockedBy)
	if blockedBy != nil && *blockedBy != "" && !domain.IsBlocker(*blockedBy) {
		return domain.PreventiveAction{}, domain.ErrBlocker, nil
	}
	now := s.now().Truncate(time.Millisecond)
	return s.Store.Update(ctx, scope.TenantID(), id, func(current domain.PreventiveAction) domain.UpdateError {
		return domain.CheckTransition(current.Status, status, u.Note)
	}, ActionChange{
		ID: strings.ToLower(s.RandomHex(32)), CreatedAt: now, Status: status, Progress: u.Progress, Note: u.Note,
		EvidenceURL: u.EvidenceURL, DecidedBy: actor, Receipt: receipt,
		Block: domain.NextBlock(status, blockedBy, u.BlockedReason, now),
	})
}

// List returns the scope's plans: due date ascending, then newest first, then id.
func (s Service) List(ctx context.Context, scope tenancy.Scope) ([]domain.PreventiveAction, error) {
	return s.Store.List(ctx, scope.TenantID(), scope.ProjectID)
}

// SituationRoom is situationRoom over the scope's plans.
func (s Service) SituationRoom(ctx context.Context, scope tenancy.Scope) (domain.SituationRoom, error) {
	actions, err := s.List(ctx, scope)
	if err != nil {
		return domain.SituationRoom{}, err
	}
	return domain.NewSituationRoom(actions, s.Today()), nil
}

// Summary is preventionSummary over the scope's plans.
func (s Service) Summary(ctx context.Context, scope tenancy.Scope) (domain.Summary, error) {
	actions, err := s.List(ctx, scope)
	if err != nil {
		return domain.Summary{}, err
	}
	return domain.NewSummary(scope.ProjectID, actions, s.Today()), nil
}

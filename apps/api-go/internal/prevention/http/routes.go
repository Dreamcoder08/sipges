// Package http serves apps/api/src/contexts/prevention/http/prevention-routes.ts with the same
// JSON: GET /system/prevention/actions, /situation-room and /summary, and (writes.go) POST
// /system/prevention/actions and PATCH /system/prevention/actions/{id}. The scope's project is
// always used; the session, project scope and role gate ran before (internal/app).
package http

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/prevention/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// isoSeconds is isoSeconds of platform/http/time.ts: ISO 8601 UTC without fractional seconds.
func isoSeconds(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05Z") }

type blockJSON struct {
	By     string `json:"by"`
	Reason string `json:"reason"`
	Since  string `json:"since"`
}

type receiptJSON struct {
	AttachmentID string `json:"attachment_id"`
	FileName     string `json:"file_name"`
	SHA256       string `json:"sha256"`
	DecidedBy    string `json:"decided_by"`
}

type entryJSON struct {
	ID          string       `json:"id"`
	ActionID    string       `json:"action_id"`
	CreatedAt   string       `json:"created_at"`
	Status      string       `json:"status"`
	Progress    int          `json:"progress"`
	Note        string       `json:"note"`
	EvidenceURL *string      `json:"evidence_url"`
	Receipt     *receiptJSON `json:"receipt"`
}

type actionJSON struct {
	ID          string      `json:"id"`
	ProjectID   string      `json:"project_id"`
	AlertID     string      `json:"alert_id"`
	Title       string      `json:"title"`
	Responsible string      `json:"responsible"`
	DueDate     string      `json:"due_date"`
	Description string      `json:"description"`
	Status      string      `json:"status"`
	Progress    int         `json:"progress"`
	CreatedAt   string      `json:"created_at"`
	UpdatedAt   string      `json:"updated_at"`
	Blocked     *blockJSON  `json:"blocked"`
	History     []entryJSON `json:"history"`
}

// toActionJSON is actionJSON of prevention-routes.ts.
func toActionJSON(a domain.PreventiveAction) actionJSON {
	out := actionJSON{
		ID: a.ID, ProjectID: a.ProjectID, AlertID: a.AlertID, Title: a.Title, Responsible: a.Responsible,
		DueDate: a.DueDate, Description: a.Description, Status: string(a.Status), Progress: a.Progress,
		CreatedAt: isoSeconds(a.CreatedAt), UpdatedAt: isoSeconds(a.UpdatedAt),
		History: make([]entryJSON, 0, len(a.History)),
	}
	if a.Block != nil {
		out.Blocked = &blockJSON{By: a.Block.By, Reason: a.Block.Reason, Since: isoSeconds(a.Block.Since)}
	}
	for _, h := range a.History {
		e := entryJSON{
			ID: h.ID, ActionID: h.ActionID, CreatedAt: isoSeconds(h.CreatedAt), Status: string(h.Status),
			Progress: h.Progress, Note: h.Note, EvidenceURL: h.EvidenceURL,
		}
		if h.Receipt != nil {
			e.Receipt = &receiptJSON{AttachmentID: h.Receipt.AttachmentID, FileName: h.Receipt.FileName, SHA256: h.Receipt.SHA256}
			if h.DecidedBy != nil {
				e.Receipt.DecidedBy = *h.DecidedBy
			}
		}
		out.History = append(out.History, e)
	}
	return out
}

type roomItemJSON struct {
	ID            string  `json:"id"`
	Title         string  `json:"title"`
	Responsible   string  `json:"responsible"`
	DueDate       string  `json:"due_date"`
	Status        string  `json:"status"`
	Progress      int     `json:"progress"`
	BlockedBy     *string `json:"blocked_by"`
	BlockedReason *string `json:"blocked_reason"`
	BlockedSince  *string `json:"blocked_since"`
}

type roomJSON struct {
	Blocked        []roomItemJSON      `json:"blocked"`
	Overdue        []roomItemJSON      `json:"overdue"`
	Moving         int                 `json:"moving"`
	BlockedByCount domain.BlockerCount `json:"blocked_by_count"`
}

func toRoomItems(actions []domain.PreventiveAction) []roomItemJSON {
	items := make([]roomItemJSON, 0, len(actions))
	for _, a := range actions {
		item := roomItemJSON{
			ID: a.ID, Title: a.Title, Responsible: a.Responsible, DueDate: a.DueDate,
			Status: string(a.Status), Progress: a.Progress,
		}
		if a.Block != nil {
			since := isoSeconds(a.Block.Since)
			item.BlockedBy, item.BlockedReason, item.BlockedSince = &a.Block.By, &a.Block.Reason, &since
		}
		items = append(items, item)
	}
	return items
}

// Routes registers the prevention read routes on mux.
func Routes(mux *http.ServeMux, service application.Service, log *slog.Logger) {
	mux.HandleFunc("GET /system/prevention/actions", handle(log, func(ctx context.Context, scope tenancy.Scope) (any, error) {
		actions, err := service.List(ctx, scope)
		out := make([]actionJSON, 0, len(actions))
		for _, a := range actions {
			out = append(out, toActionJSON(a))
		}
		return out, err
	}))
	mux.HandleFunc("GET /system/prevention/situation-room", handle(log, func(ctx context.Context, scope tenancy.Scope) (any, error) {
		room, err := service.SituationRoom(ctx, scope)
		return roomJSON{
			Blocked: toRoomItems(room.Blocked), Overdue: toRoomItems(room.Overdue),
			Moving: room.Moving, BlockedByCount: room.BlockedByCount,
		}, err
	}))
	mux.HandleFunc("GET /system/prevention/summary", handle(log, func(ctx context.Context, scope tenancy.Scope) (any, error) {
		return service.Summary(ctx, scope)
	}))
}

// handle answers 200 with the work's JSON, or the TypeScript API's onError 500 when the request
// has no resolved project or the work fails.
func handle(log *slog.Logger, work func(context.Context, tenancy.Scope) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scope, ok := tenancyhttp.ScopeFrom(r.Context())
		var (
			body any
			err  = tenancyhttp.ErrNoScope
		)
		if ok {
			body, err = work(r.Context(), scope)
		}
		if err != nil {
			// Only the event: driver errors may carry connection details.
			if log != nil {
				log.LogAttrs(r.Context(), slog.LevelError, "prevention read failed",
					slog.String("request_id", httpx.RequestIDFrom(r.Context())))
			}
			httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, body)
	}
}

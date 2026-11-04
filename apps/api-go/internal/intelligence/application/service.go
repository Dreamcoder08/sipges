// Package application is the Go side of
// apps/api/src/contexts/intelligence/application/intelligence-service.ts: the scope's territorial
// alerts, one alert and their summary (Service), and the writes that need no embeddings provider
// (Writes): the classifier, the text analysis and alert decisions. Creating alerts, the semantic
// analysis and the embedder stay in TypeScript (embeddings and the egress guard).
package application

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// AlertStore reads territorial alerts inside one tenant.
type AlertStore interface {
	// List returns the project's alerts, newest first, at most limit.
	List(ctx context.Context, tenantID, projectID string, limit int) ([]domain.Alert, error)
	// Get returns the tenant's alert with that id, or nil.
	Get(ctx context.Context, tenantID, id string) (*domain.Alert, error)
}

// Service answers the intelligence read routes.
type Service struct {
	Store AlertStore
}

// ListAlerts is listAlerts: the scope's alerts, newest first, limit clamped to 1..200.
func (s Service) ListAlerts(ctx context.Context, scope tenancy.Scope, limit int64) ([]domain.Alert, error) {
	return s.Store.List(ctx, scope.TenantID(), scope.ProjectID, domain.ListLimit(limit))
}

// GetAlert is getAlert: the alert when it belongs to the scope's project, else nil.
func (s Service) GetAlert(ctx context.Context, scope tenancy.Scope, id string) (*domain.Alert, error) {
	if !domain.LookupID(id) {
		return nil, nil
	}
	alert, err := s.Store.Get(ctx, scope.TenantID(), id)
	if err != nil || alert == nil || alert.ProjectID != scope.ProjectID {
		return nil, err
	}
	return alert, nil
}

// Summary is summary: alertSummary over the scope's 200 newest alerts.
func (s Service) Summary(ctx context.Context, scope tenancy.Scope) (domain.Summary, error) {
	alerts, err := s.Store.List(ctx, scope.TenantID(), scope.ProjectID, domain.MaxAlertList)
	if err != nil {
		return domain.Summary{}, err
	}
	return domain.NewSummary(scope.ProjectID, alerts)
}

// Engine runs one operation of the analytics WebAssembly module (engines/go/wasmengine).
type Engine interface {
	Call(ctx context.Context, request []byte) (json.RawMessage, error)
}

// NarrativeReader returns the payloads of the tenant's narrative records, newest first.
type NarrativeReader interface {
	Narratives(ctx context.Context, tenantID string) ([]json.RawMessage, error)
}

// Decision is one reviewer decision on an alert of the scope's project.
type Decision struct {
	ID, ProjectID, Status, Note, Actor string
	At                                 time.Time
}

// DecisionStore applies a decision inside one tenant transaction: it locks the alert, applies
// the four-eyes rule and writes the change with its REVIEW audit row.
type DecisionStore interface {
	Decide(ctx context.Context, tenantID string, d Decision) (DecisionResult, error)
}

// DecisionResult is decideAlert's value or error kind.
type DecisionResult struct {
	Err           domain.DecisionError
	Status        string
	PendingSecond bool
}

// Writes answers the intelligence write routes that need no embeddings provider.
type Writes struct {
	Engine     Engine
	Narratives NarrativeReader
	Decisions  DecisionStore
	Now        func() time.Time
}

// Classify is classify(payload): the classifier engine's value for the payload, a JSON object.
func (w Writes) Classify(ctx context.Context, payload json.RawMessage) (json.RawMessage, error) {
	request := make([]byte, 0, len(payload)+40)
	request = append(request, `{"op":"classify_record","payload":`...)
	request = append(request, payload...)
	request = append(request, '}')
	return w.Engine.Call(ctx, request)
}

// TextError is TextAnalysisError's kind ("empty" or "too_long"); "" is none.
type TextError string

// AnalyzeText is analyzeText(scope, {text, sourceUrl}): the text engine over the scope's
// narratives. The report is returned as the engine wrote it (JSON.stringify of the TypeScript).
func (w Writes) AnalyzeText(ctx context.Context, scope tenancy.Scope, text, sourceURL string) (json.RawMessage, TextError, error) {
	narratives, err := w.Narratives.Narratives(ctx, scope.TenantID())
	if err != nil {
		return nil, "", err
	}
	request, err := json.Marshal(struct {
		Op         string            `json:"op"`
		Text       string            `json:"text"`
		ProjectID  string            `json:"project_id"`
		SourceURL  string            `json:"source_url"`
		Narratives []json.RawMessage `json:"narratives"`
	}{"text_analysis", text, scope.ProjectID, sourceURL, narratives})
	if err != nil {
		return nil, "", err
	}
	raw, err := w.Engine.Call(ctx, request)
	if err != nil {
		return nil, "", err
	}
	var result struct {
		OK    bool            `json:"ok"`
		Value json.RawMessage `json:"value"`
		Error struct {
			Kind TextError `json:"kind"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, "", err
	}
	if !result.OK {
		if result.Error.Kind != "empty" && result.Error.Kind != "too_long" {
			return nil, "", fmt.Errorf("intelligence: unknown text analysis error %q", result.Error.Kind)
		}
		return nil, result.Error.Kind, nil
	}
	return result.Value, "", nil
}

// DecideAlert is decideAlert(scope, {id, status, note}, actor).
func (w Writes) DecideAlert(ctx context.Context, scope tenancy.Scope, id, status, note, actor string) (DecisionResult, error) {
	if kind := domain.CheckDecision(id, status, note); kind != "" {
		return DecisionResult{Err: kind}, nil
	}
	now := time.Now
	if w.Now != nil {
		now = w.Now
	}
	// JavaScript dates hold milliseconds: store the instant the TypeScript API would.
	at := now().Truncate(time.Millisecond)
	return w.Decisions.Decide(ctx, scope.TenantID(), Decision{
		ID: id, ProjectID: scope.ProjectID, Status: status, Note: note, Actor: actor, At: at,
	})
}

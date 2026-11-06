// Package application is the JSON side of
// apps/api/src/contexts/analytics/application/analytics-service.ts: each use case reads the
// scope's records, then runs an engine. The dashboard counters run in Go (domain); the
// situational, strategic, consensus and integrated analyses run in the Rust analytics module
// (engines/README.md, ABI), whose answer is JSON.stringify of the TypeScript result. The DOCX
// reports are built from those answers (reports.go), and the conflict-risk prediction runs the
// same module (conflict_risk.go).
package application

import (
	"context"
	"encoding/json"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analytics/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// RecordReader reads a tenant's module records under its row-level security: one entry per
// requested module, newest first, empty when there are none.
type RecordReader interface {
	// Read returns the complete stored payloads (sql-analytics-record-reader.ts).
	Read(ctx context.Context, tenantID string, modules []string) (domain.RecordsByModule, error)
	// ReadDashboard returns only the payload fields the dashboard counts
	// (sql-dashboard-record-reader.ts).
	ReadDashboard(ctx context.Context, tenantID string, modules []string) (domain.RecordsByModule, error)
}

// LabelSource is Tenancy's label(scope): the tenant's display label, nil when the tenant does
// not exist.
type LabelSource interface {
	Label(ctx context.Context, scope tenancy.Scope) (*string, error)
}

// Engine runs one request of the analytics WebAssembly module and returns its `value`;
// *wasmengine.Engine satisfies it.
type Engine interface {
	Call(ctx context.Context, request []byte) (json.RawMessage, error)
}

// Service answers the analytics JSON routes.
type Service struct {
	Records RecordReader
	Labels  LabelSource
	Engine  Engine
	// Renderer writes the Word reports.
	Renderer ReportRenderer
	// Now is the clock of generated_at; nil means time.Now.
	Now func() time.Time
}

func (s Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// generatedAt is `${clock.now().toISOString().slice(0, 19)}Z`: UTC to the second, truncated.
func (s Service) generatedAt() string {
	return s.now().UTC().Format("2006-01-02T15:04:05") + "Z"
}

// request is one analytics engine request (engines/README.md, "Requests").
type request struct {
	Op          string                 `json:"op"`
	Records     domain.RecordsByModule `json:"records"`
	ProjectID   string                 `json:"project_id"`
	GeneratedAt string                 `json:"generated_at"`
	// TenantLabel is sent only to situational: a JSON string or null.
	TenantLabel json.RawMessage `json:"tenant_label,omitempty"`
}

func (s Service) run(ctx context.Context, req request) (json.RawMessage, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	return s.Engine.Call(ctx, body)
}

// Dashboard is dashboard(scope): the executive counters (app.py `/api/dashboard`).
func (s Service) Dashboard(ctx context.Context, scope tenancy.Scope) (domain.DashboardSummary, error) {
	records, err := s.Records.ReadDashboard(ctx, scope.TenantID(), domain.DashboardModules)
	if err != nil {
		return domain.DashboardSummary{}, err
	}
	return domain.NewDashboardSummary(records)
}

// Situational is situational(scope): buildSituational over the situational modules, naming a
// project without a Proyectos record by the tenant's label.
func (s Service) Situational(ctx context.Context, scope tenancy.Scope) (json.RawMessage, error) {
	records, err := s.Records.Read(ctx, scope.TenantID(), domain.SituationalModules)
	if err != nil {
		return nil, err
	}
	generatedAt := s.generatedAt()
	label, err := s.Labels.Label(ctx, scope)
	if err != nil {
		return nil, err
	}
	tenantLabel := json.RawMessage("null")
	if label != nil {
		if tenantLabel, err = json.Marshal(*label); err != nil {
			return nil, err
		}
	}
	return s.run(ctx, request{
		Op: "situational", Records: records, ProjectID: scope.ProjectID, GeneratedAt: generatedAt,
		TenantLabel: tenantLabel,
	})
}

// extended runs op over the extended (RC 1.7) modules of the scope.
func (s Service) extended(ctx context.Context, scope tenancy.Scope, op string) (json.RawMessage, error) {
	records, err := s.Records.Read(ctx, scope.TenantID(), domain.ExtendedModules)
	if err != nil {
		return nil, err
	}
	return s.run(ctx, request{Op: op, Records: records, ProjectID: scope.ProjectID, GeneratedAt: s.generatedAt()})
}

// Strategic is strategic(scope): strategicAssessment.
func (s Service) Strategic(ctx context.Context, scope tenancy.Scope) (json.RawMessage, error) {
	return s.extended(ctx, scope, "strategic")
}

// Consensus is consensus(scope): automatedConsensus.
func (s Service) Consensus(ctx context.Context, scope tenancy.Scope) (json.RawMessage, error) {
	return s.extended(ctx, scope, "consensus")
}

// Integrated is integrated(scope): integratedAnalysis, with its candidate links.
func (s Service) Integrated(ctx context.Context, scope tenancy.Scope) (json.RawMessage, error) {
	return s.extended(ctx, scope, "integrated")
}

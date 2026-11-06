package application

import (
	"context"
	"errors"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/analytics/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// ReportRenderer is ReportRenderer of ports.ts: it writes an outline as a file.
type ReportRenderer interface {
	ContentType() string
	Render(blocks []domain.ReportBlock, at time.Time) ([]byte, error)
}

// RenderedReport is RenderedReport: a Word draft ready to download.
type RenderedReport struct {
	FileName    string
	ContentType string
	Bytes       []byte
}

// errUnknownReport is unreachable: the routes name every kind.
var errUnknownReport = errors.New("analytics: unknown report")

// Report is report(kind, scope): the DOCX draft of one analysis, always for the active scope.
func (s Service) Report(ctx context.Context, kind domain.ReportKind, scope tenancy.Scope) (RenderedReport, error) {
	blocks, err := s.outline(ctx, kind, scope)
	if err != nil {
		return RenderedReport{}, err
	}
	bytes, err := s.Renderer.Render(blocks, s.now())
	if err != nil {
		return RenderedReport{}, err
	}
	return RenderedReport{FileName: domain.ReportFilenames[kind], ContentType: s.Renderer.ContentType(), Bytes: bytes}, nil
}

func (s Service) outline(ctx context.Context, kind domain.ReportKind, scope tenancy.Scope) ([]domain.ReportBlock, error) {
	switch kind {
	case domain.ReportSituational:
		analysis, err := s.Situational(ctx, scope)
		if err != nil {
			return nil, err
		}
		return domain.SituationalReport(analysis)
	case domain.ReportIntegrated:
		analysis, err := s.Integrated(ctx, scope)
		if err != nil {
			return nil, err
		}
		return domain.IntegratedReport(analysis)
	case domain.ReportConsensus:
		analysis, err := s.Consensus(ctx, scope)
		if err != nil {
			return nil, err
		}
		return domain.ConsensusReport(analysis)
	case domain.ReportStrategic:
		records, err := s.Records.Read(ctx, scope.TenantID(), domain.ExtendedModules)
		if err != nil {
			return nil, err
		}
		assessment, err := s.run(ctx, request{Op: "strategic", Records: records, ProjectID: scope.ProjectID, GeneratedAt: s.generatedAt()})
		if err != nil {
			return nil, err
		}
		situational, err := s.Situational(ctx, scope)
		if err != nil {
			return nil, err
		}
		return domain.StrategicReport(records, assessment, situational)
	}
	return nil, errUnknownReport
}

package application_test

import (
	"context"
	"errors"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// recordingGuard keeps the request it was opened with and answers err.
type recordingGuard struct {
	got *privacy.Request
	err error
}

func (g *recordingGuard) Open(_ context.Context, request privacy.Request) (*privacy.Session, error) {
	g.got = &request
	return nil, g.err
}

func tool(t *testing.T, name string) domain.Tool {
	t.Helper()
	for _, candidate := range domain.Tools {
		if candidate.Name == name {
			return candidate
		}
	}
	t.Fatalf("no tool %s", name)
	return domain.Tool{}
}

func TestRunAsAnalystOpensTheGuardOnTheAnalystChannel(t *testing.T) {
	t.Parallel()
	guard := &recordingGuard{err: errors.New("stop here")}
	_, err := application.MCP{Guard: guard}.RunAsAnalyst(t.Context(), tool(t, domain.ToolSearchRecords), "ACME/NORTE", records.NewObject())
	if err == nil {
		t.Fatal("expected the guard's error")
	}
	if guard.got == nil || guard.got.Channel != privacy.ChannelAnalyst || guard.got.TenantID != "ACME/NORTE" ||
		guard.got.Purpose != domain.ToolSearchRecords || guard.got.Actor != nil {
		t.Fatalf("guard request = %+v", guard.got)
	}
}

func TestRunAsAnalystRefusesWhileExternalAIIsOff(t *testing.T) {
	t.Parallel()
	guard := &recordingGuard{err: privacy.ErrDisabled}
	got, err := application.MCP{Guard: guard}.RunAsAnalyst(t.Context(), tool(t, domain.ToolSearchRecords), "ACME/NORTE", records.NewObject())
	if err != nil || got.OK || got.Error != privacy.ExternalAIDisabled {
		t.Fatalf("result = %+v, err = %v", got, err)
	}
}

func TestRunAsAnalystNeverRunsAWriteTool(t *testing.T) {
	t.Parallel()
	guard := &recordingGuard{}
	got, err := application.MCP{Guard: guard}.RunAsAnalyst(t.Context(), tool(t, domain.ToolCreateRecord), "ACME/NORTE", records.NewObject())
	if err != nil || got.OK || got.Error == "" || guard.got != nil {
		t.Fatalf("result = %+v, err = %v, guard opened = %v", got, err, guard.got != nil)
	}
}

func TestRunStillOpensTheGuardOnTheMCPChannelAsTheKey(t *testing.T) {
	t.Parallel()
	guard := &recordingGuard{err: errors.New("stop here")}
	principal := domain.Principal{KeyID: 7, TenantID: "ACME/NORTE", Name: "Integración", Access: "read", Clearance: "full"}
	_, _ = application.MCP{Guard: guard}.Run(t.Context(), tool(t, domain.ToolSearchRecords), principal, records.NewObject())
	if guard.got == nil || guard.got.Channel != privacy.ChannelMCP || guard.got.Actor == nil {
		t.Fatalf("guard request = %+v", guard.got)
	}
}

package application

import (
	"context"
	"errors"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	ontologyapp "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/application"
	ontology "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	sanitised "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/domain"
	recordsapp "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The write tools of mcp-tools.ts, which only a write key sees. They create data and answer only
// with the id it was given, so the egress guard has nothing to look at.

func acknowledge(data any) (ToolResult, error) {
	return ToolResult{OK: true, Data: privacy.ExemptPayload(data, privacy.ExemptAcknowledgement)}, nil
}

func (m MCP) runWrite(ctx context.Context, tool domain.Tool, principal domain.Principal, input *records.Object) (ToolResult, error) {
	switch tool.Name {
	case domain.ToolCreateRecord:
		return m.createRecord(ctx, principal, input)
	case domain.ToolLinkRecords:
		return m.linkRecords(ctx, principal, input)
	}
	return ToolResult{}, ErrToolUnavailable
}

type createdJSON struct {
	Module sanitised.Text `json:"module"`
	ID     sanitised.Text `json:"id"`
}

func (m MCP) createRecord(ctx context.Context, principal domain.Principal, input *records.Object) (ToolResult, error) {
	slug, payload := textOf(input, "module"), objectOf(input, "payload")
	module, known := records.ModuleForSlug(slug)
	if !known {
		return ToolResult{Error: "Módulo no válido"}, nil
	}
	if domain.PayloadProject(payload, principal.ProjectID()) {
		return ToolResult{Error: "No se permite escribir en otro proyecto"}, nil
	}
	id, problem, err := m.Creator.Create(ctx, principal.TenantID, module, payload)
	switch {
	case errors.Is(err, recordsapp.ErrExhausted):
		return ToolResult{Error: "No se pudo asignar un id"}, nil
	case err != nil:
		return ToolResult{}, err
	case problem != nil:
		return ToolResult{Error: problem.Message}, nil
	}
	return acknowledge(createdJSON{sanitised.Text(slug), sanitised.Text(id)})
}

type linkedJSON struct {
	ID int64 `json:"id"`
}

// linkEnd reads one end of a link. The database gets what Node would send it: U+FFFD for a lone
// surrogate.
func linkEnd(input *records.Object, field string) ontology.Ref {
	end := objectOf(input, field)
	return ontology.Ref{Module: textOf(end, "module"), ID: records.WellFormed(textOf(end, "id"))}
}

func (m MCP) linkRecords(ctx context.Context, principal domain.Principal, input *records.Object) (ToolResult, error) {
	id, problem, err := m.Ontology.Link(ctx, principal.TenantID, ontologyapp.LinkInput{
		LinkType: textOf(input, "link_type"),
		Source:   linkEnd(input, "source"),
		Target:   linkEnd(input, "target"),
		Note:     records.WellFormed(textOf(input, "note")),
	}, domain.KeyActor(principal))
	if err != nil {
		return ToolResult{}, err
	}
	if problem != "" {
		return ToolResult{Error: "Vínculo rechazado: " + problem}, nil
	}
	return acknowledge(linkedJSON{id})
}

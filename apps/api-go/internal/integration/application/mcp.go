package application

import (
	"context"
	"errors"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	ontology "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The tools of the MCP server (mcp-tools.ts, docs/adr/0014 §7). Data leaves only as a payload the
// egress guard sealed: ToolResult accepts nothing else, and only Run builds one.

// ToolResult is what a tool answers: sealed data, or the fixed text of its refusal.
type ToolResult struct {
	OK    bool
	Data  privacy.Sanitised[any]
	Error string
}

// MCP runs the tools.
type MCP struct{}

// ErrToolUnavailable is a tool this server does not run yet; the route answers as a tool failure.
var ErrToolUnavailable = errors.New("integration: tool not available")

// Run runs a tool whose input ParseArguments already checked.
func (m MCP) Run(_ context.Context, tool domain.Tool, _ domain.Principal, _ *records.Object) (ToolResult, error) {
	if tool.Kind == domain.ToolCatalogue {
		return ToolResult{OK: true, Data: privacy.ExemptPayload[any](objectCatalogue(), privacy.ExemptConstant)}, nil
	}
	return ToolResult{}, ErrToolUnavailable
}

type catalogueObject struct {
	Module     string  `json:"module"`
	Label      string  `json:"label"`
	TitleField string  `json:"title_field"`
	DateField  *string `json:"date_field"`
}

type catalogueLink struct {
	ID      string   `json:"id"`
	Label   string   `json:"label"`
	Sources []string `json:"sources"`
	Targets []string `json:"targets"`
}

type catalogue struct {
	ObjectTypes []catalogueObject `json:"object_types"`
	LinkTypes   []catalogueLink   `json:"link_types"`
}

// objectCatalogue is the answer of list_object_types: static, no tenant data.
func objectCatalogue() catalogue {
	out := catalogue{
		ObjectTypes: make([]catalogueObject, len(ontology.ObjectTypes)),
		LinkTypes:   make([]catalogueLink, len(ontology.LinkTypes)),
	}
	for i, t := range ontology.ObjectTypes {
		out.ObjectTypes[i] = catalogueObject{Module: t.Slug, Label: t.Label, TitleField: t.TitleField}
		if t.DateField != "" {
			date := t.DateField
			out.ObjectTypes[i].DateField = &date
		}
	}
	for i, t := range ontology.LinkTypes {
		out.LinkTypes[i] = catalogueLink{ID: t.ID, Label: t.Label, Sources: t.Sources, Targets: t.Targets}
	}
	return out
}

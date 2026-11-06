package application

import (
	"context"
	"errors"
	"strconv"

	analyst "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	ontologyapp "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/application"
	ontology "github.com/Dreamcoder08/sipges/apps/api-go/internal/ontology/domain"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	recordsapp "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
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

// MCPOntology is the ontology a tool reads, in the tenant of each call.
type MCPOntology interface {
	Search(ctx context.Context, tenantID string, query ontology.Units, slugs []string, limit int64, visible ontologyapp.VisibleField) ([]ontologyapp.Hit, error)
	Neighbours(ctx context.Context, tenantID, slug, id string) (*ontologyapp.Links, error)
	Timeline(ctx context.Context, tenantID, from, to string, slugs []string, limit int64) (*ontologyapp.Timeline, error)
	// Link answers the new link's id, or the refusal: a link problem, "missing" or "duplicate".
	Link(ctx context.Context, tenantID string, in ontologyapp.LinkInput, actor string) (int64, string, error)
}

// MCPRecords is the record a tool reads.
type MCPRecords interface {
	Get(ctx context.Context, tenantID, module, id string) (*recordsapp.StoredRecord, error)
}

// MCPCreator creates a record: its id, the field refused, or recordsapp.ErrExhausted.
type MCPCreator interface {
	Create(ctx context.Context, tenantID, module string, given *records.Object) (string, *records.Problem, error)
}

// MCPBriefings gives a record's briefing as session's reader may see it; nil when it is missing.
type MCPBriefings interface {
	Briefing(ctx context.Context, tenantID, slug, id string, session *privacy.Session) (*analyst.Assistance, error)
}

// Egress is the egress guard.
type Egress interface {
	Open(ctx context.Context, request privacy.Request) (*privacy.Session, error)
}

// MCP runs the tools. Every tool that reads tenant data goes through Guard (docs/adr/0030); nil
// when SIPGES_DATA_KEY is missing, and then every such tool is refused.
type MCP struct {
	Ontology MCPOntology
	Records  MCPRecords
	Creator  MCPCreator
	Analyst  MCPBriefings
	Guard    Egress
}

// ErrToolUnavailable is a tool without a handler; the route answers as a tool failure.
var ErrToolUnavailable = errors.New("integration: tool not available")

// Run is runTool, for a tool whose input ParseArguments already checked. A read tool is refused
// while the project keeps external AI off; otherwise its data is sanitised and the release is
// logged before it can be returned. The catalogue and the write tools carry no tenant data out: the
// catalogue is static and a write answers with the id it assigned.
func (m MCP) Run(ctx context.Context, tool domain.Tool, principal domain.Principal, input *records.Object) (ToolResult, error) {
	switch tool.Kind {
	case domain.ToolCatalogue:
		return ToolResult{OK: true, Data: privacy.ExemptPayload[any](objectCatalogue(), privacy.ExemptConstant)}, nil
	case domain.ToolRead:
		return m.runRead(ctx, tool, principal, input)
	}
	return m.runWrite(ctx, tool, principal, input)
}

func (m MCP) runRead(ctx context.Context, tool domain.Tool, principal domain.Principal, input *records.Object) (ToolResult, error) {
	if m.Guard == nil {
		return ToolResult{Error: privacy.ExternalAIDisabled}, nil
	}
	actor := domain.KeyActor(principal) + " (clave " + strconv.Itoa(principal.KeyID) + ")"
	session, err := m.Guard.Open(ctx, privacy.Request{
		TenantID: principal.TenantID, Channel: privacy.ChannelMCP, Purpose: tool.Name, Actor: &actor,
	})
	if errors.Is(err, privacy.ErrDisabled) {
		return ToolResult{Error: privacy.ExternalAIDisabled}, nil
	}
	if err != nil {
		return ToolResult{}, err
	}
	call := readCall{MCP: m, tenant: principal.TenantID, session: session, input: input}
	var data any
	var refusal string
	switch tool.Name {
	case domain.ToolSearchRecords:
		data, err = call.search(ctx)
	case domain.ToolGetRecord:
		data, refusal, err = call.record(ctx)
	case domain.ToolGetLinks:
		data, refusal, err = call.links(ctx)
	case domain.ToolGetTimeline:
		data, refusal, err = call.timeline(ctx)
	case domain.ToolGetBriefing:
		data, refusal, err = call.briefing(ctx)
	default:
		err = ErrToolUnavailable
	}
	if err != nil {
		return ToolResult{}, err
	}
	// A refusal carries a fixed message, never a record's content.
	if refusal != "" {
		return ToolResult{Error: refusal}, nil
	}
	sealed, err := privacy.Release(ctx, session, data)
	if err != nil {
		return ToolResult{}, err
	}
	return ToolResult{OK: true, Data: sealed}, nil
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

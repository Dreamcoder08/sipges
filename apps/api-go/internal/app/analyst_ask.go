//nolint:misspell // Spanish refusals, as the MCP server words them.
package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"

	analyst "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	analystdomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	analystsql "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/infrastructure"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	integration "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/application"
	integrationdomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/config"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The Inicio analyst (odd/tasks/agentic-analyst.md S2) composed here, because integration
// already depends on analyst: the loop reads through the MCP read tools, on the analyst channel.

// askFactory builds the analyst of one project; nil when no provider is configured.
func askFactory(d Deps) (func(ctx context.Context, tenantID string) (*analyst.Ask, error), error) {
	settings, err := config.LoadAnalyst(os.LookupEnv)
	if err != nil || !settings.Enabled {
		return nil, err
	}
	tools, _, err := mcpTools(d)
	if err != nil {
		return nil, err
	}
	model := toolModel(settings)
	enabled := externalAISwitch{d.Pool}
	return func(ctx context.Context, tenantID string) (*analyst.Ask, error) {
		if tools.Guard == nil {
			return nil, privacy.ErrDisabled // without SIPGES_DATA_KEY nothing may leave
		}
		on, err := enabled.Enabled(ctx, tenantID)
		if err != nil {
			return nil, err
		}
		if !on {
			return nil, privacy.ErrDisabled // the question itself never reaches the model
		}
		propose := analyst.Proposing{Store: analystsql.Proposals{DB: d.Pool}, Rules: proposalRules{}, Now: d.Now}
		return &analyst.Ask{
			Model: model, Tools: askTools{mcp: tools, tenantID: tenantID, propose: propose},
			Seal: sealQuestion(tools.Guard, tenantID),
		}, nil
	}, nil
}

// askPurpose names the question's release in the egress log.
const askPurpose = "ask"

// sealQuestion releases the question, and the earlier turns of a follow-up, as free text on the
// analyst channel, as semantic search releases its query: known names and contact data scrubbed,
// and one release logged for all of them (odd/tasks/chat-first-ui.md T9).
func sealQuestion(guard integration.Egress, tenantID string) analyst.Seal {
	return func(ctx context.Context, texts []string) ([]privacy.Sanitised[string], error) {
		session, err := guard.Open(ctx, privacy.Request{TenantID: tenantID, Channel: privacy.ChannelAnalyst, Purpose: askPurpose})
		if err != nil {
			return nil, err
		}
		scrubbed := make([]string, 0, len(texts))
		for _, text := range texts {
			scrubbed = append(scrubbed, session.Text(text))
		}
		return privacy.ReleaseMany(ctx, session, scrubbed)
	}
}

// toolModel is the configured provider's tool-calling adapter.
func toolModel(settings config.Analyst) analyst.ToolModel {
	if settings.Provider == config.ProviderOpenAICompatible {
		return analystsql.NewOpenAICompatible(settings.Model, os.LookupEnv)
	}
	return analystsql.NewClaude(settings.Model, os.LookupEnv)
}

// askTools implements analyst.ToolRunner over the MCP read tools of one project plus the two
// proposal tools (S4). Write tools are neither offered nor run: the analyst proposes writes, it
// never makes them, and a proposal waits in Bandeja until a person decides it.
type askTools struct {
	mcp      integration.MCP
	tenantID string
	propose  analyst.Proposing
}

// unknownTool is the MCP server's refusal of a tool it does not offer.
const unknownTool = "Herramienta desconocida: "

func readTools() []integrationdomain.Tool {
	return integrationdomain.ToolsFor(integrationdomain.Principal{Access: "read"})
}

func (a askTools) Specs() []analyst.ToolSpec {
	tools := readTools()
	specs := make([]analyst.ToolSpec, 0, len(tools))
	for _, tool := range tools {
		description, _ := tool.Descriptor.Get("description")
		text, _ := description.(string)
		schema, _ := tool.Descriptor.Get("inputSchema")
		specs = append(specs, analyst.ToolSpec{Name: tool.Name, Description: text, InputSchema: records.AppendJSON(nil, schema)})
	}
	return append(specs, proposalSpecs...)
}

func (a askTools) Run(ctx context.Context, name string, input json.RawMessage) (analyst.ToolOutput, error) {
	if name == proposeRecord || name == proposeLink {
		return a.proposal(ctx, name, input)
	}
	var tool *integrationdomain.Tool
	for _, candidate := range readTools() {
		if candidate.Name == name {
			tool = &candidate
			break
		}
	}
	if tool == nil {
		return analyst.ToolOutput{Refusal: unknownTool + name}, nil
	}
	raw := input
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	value, err := records.ParseBody(raw)
	object, ok := value.(*records.Object)
	if err != nil || !ok {
		return analyst.ToolOutput{Refusal: "Argumentos no válidos"}, nil
	}
	parsed, issues := tool.ParseArguments(object)
	if issues != "" {
		return analyst.ToolOutput{Refusal: "Argumentos no válidos: " + issues}, nil
	}
	result, err := a.mcp.RunAsAnalyst(ctx, *tool, a.tenantID, parsed)
	if err != nil {
		return analyst.ToolOutput{}, err
	}
	if !result.OK {
		return analyst.ToolOutput{Refusal: result.Error}, nil
	}
	refs, err := recordRefs(result.Data)
	if err != nil {
		return analyst.ToolOutput{}, err
	}
	return analyst.ToolOutput{OK: true, Data: result.Data, Records: refs}, nil
}

// recordRefs finds the records in a tool's sealed answer: every object naming a module and an id,
// in document order, except those the guard withheld. It reads the same JSON the model will read.
func recordRefs(data privacy.Sanitised[any]) ([]analystdomain.RecordRef, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, errors.New("analyst: unreadable tool answer")
	}
	tree, err := records.ParseBody(raw)
	if err != nil {
		return nil, errors.New("analyst: unreadable tool answer")
	}
	var refs []analystdomain.RecordRef
	var walk func(any)
	walk = func(node any) {
		switch v := node.(type) {
		case *records.Object:
			text := func(key string) string {
				value, _ := v.Get(key)
				s, _ := value.(string)
				return s
			}
			withheld, _ := v.Get("withheld")
			if module, id := text("module"), text("id"); module != "" && id != "" && withheld != true {
				refs = append(refs, analystdomain.RecordRef{Slug: module, ID: id, Title: text("title")})
			}
			for _, key := range v.Keys() {
				child, _ := v.Get(key)
				walk(child)
			}
		case []any:
			for _, item := range v {
				walk(item)
			}
		}
	}
	walk(tree)
	return refs, nil
}

// The proposal tools (odd/tasks/agentic-analyst.md S4). Their descriptions are how the model
// learns them; the system prompt stays as it is.
const (
	proposeRecord = "propose_record"
	proposeLink   = "propose_link"
	// proposedState is what the model reads back with the id: the proposal's id and that it waits for a person.
	proposedState = "pendiente de aprobación en Bandeja"
)

var proposalSpecs = []analyst.ToolSpec{
	{
		Name: proposeRecord,
		Description: "Propone crear un registro. No escribe nada: la propuesta queda pendiente en Bandeja hasta que " +
			"una persona con permiso de escritura en ese módulo la apruebe o la descarte. Úsalo solo si la persona " +
			"pide registrar algo; los valores son texto y se validan con las reglas del módulo.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{` +
			`"module":{"type":"string","maxLength":40,"description":"Tipo de objeto: acciones, compromisos, eventos…"},` +
			`"fields":{"type":"object","maxProperties":30,"additionalProperties":{"type":"string","maxLength":2000},"description":"Campos del registro, con los nombres del módulo"},` +
			`"reason":{"type":"string","minLength":1,"maxLength":500,"description":"Por qué lo propones, citando los registros que lo justifican"}},` +
			`"required":["module","fields","reason"],"additionalProperties":false}`),
	},
	{
		Name: proposeLink,
		Description: "Propone vincular dos registros existentes con un tipo de vínculo de la ontología. No escribe nada: " +
			"la propuesta queda pendiente en Bandeja hasta que una persona con permiso la apruebe o la descarte.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{` +
			`"link_type":{"type":"string","maxLength":40,"description":"Tipo de vínculo, de list_object_types"},` +
			`"source":{"type":"object","properties":{"module":{"type":"string"},"id":{"type":"string"}},"required":["module","id"]},` +
			`"target":{"type":"object","properties":{"module":{"type":"string"},"id":{"type":"string"}},"required":["module","id"]},` +
			`"reason":{"type":"string","minLength":1,"maxLength":500,"description":"Por qué lo propones"}},` +
			`"required":["link_type","source","target","reason"],"additionalProperties":false}`),
	},
}

const invalidArguments = "Argumentos no válidos"

func textOf(o *records.Object, key string) (string, bool) {
	value, _ := o.Get(key)
	s, ok := value.(string)
	return s, ok
}

func refOf(o *records.Object, key string) (analystdomain.Ref, bool) {
	value, _ := o.Get(key)
	end, ok := value.(*records.Object)
	if !ok {
		return analystdomain.Ref{}, false
	}
	module, ok := textOf(end, "module")
	id, ok2 := textOf(end, "id")
	return analystdomain.Ref{Slug: module, ID: id}, ok && ok2
}

// draftOf reads a proposal tool's arguments into a checked draft, or the refusal.
func draftOf(name string, args *records.Object) (analystdomain.Proposal, string) {
	reason, _ := textOf(args, "reason")
	if name == proposeLink {
		linkType, ok := textOf(args, "link_type")
		source, ok2 := refOf(args, "source")
		target, ok3 := refOf(args, "target")
		if !ok || !ok2 || !ok3 {
			return analystdomain.Proposal{}, invalidArguments
		}
		return analystdomain.LinkDraft(analystdomain.ProposedLink{LinkType: linkType, Source: source, Target: target}, reason)
	}
	module, ok := textOf(args, "module")
	value, _ := args.Get("fields")
	fields, ok2 := value.(*records.Object)
	if !ok || !ok2 {
		return analystdomain.Proposal{}, invalidArguments
	}
	payload := make([]analystdomain.Field, 0, len(fields.Keys()))
	for _, key := range fields.Keys() {
		v, _ := fields.Get(key)
		payload = append(payload, analystdomain.Field{Key: key, Value: v})
	}
	return analystdomain.RecordDraft(analystdomain.ProposedRecord{Slug: module, Payload: payload}, reason)
}

// proposal runs a proposal tool: it checks the draft as the real write would, then stores it as
// pending for the person asking. It holds no way to write a record or a link.
func (a askTools) proposal(ctx context.Context, name string, input json.RawMessage) (analyst.ToolOutput, error) {
	principal, ok := identityhttp.PrincipalFrom(ctx)
	if !ok {
		return analyst.ToolOutput{Refusal: analystdomain.RefusedRole}, nil
	}
	value, err := records.ParseBody(input)
	args, isObject := value.(*records.Object)
	if err != nil || !isObject {
		return analyst.ToolOutput{Refusal: invalidArguments}, nil
	}
	draft, refusal := draftOf(name, args)
	if refusal != "" {
		return analyst.ToolOutput{Refusal: refusal}, nil
	}
	if !mayWrite(ctx, http.MethodPost, analyst.ProposalWritePath(draft)) {
		return analyst.ToolOutput{Refusal: analystdomain.RefusedRole}, nil
	}
	id, refusal, err := a.propose.Propose(ctx, a.tenantID, principal.Username, draft)
	if err != nil || refusal != "" {
		return analyst.ToolOutput{Refusal: refusal}, err
	}
	ack := map[string]string{"propuesta": id, "estado": proposedState}
	return analyst.ToolOutput{OK: true, Data: privacy.ExemptPayload[any](ack, privacy.ExemptAcknowledgement)}, nil
}

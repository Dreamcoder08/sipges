//nolint:misspell // Spanish refusals, as the MCP server words them.
package app

import (
	"context"
	"encoding/json"
	"errors"
	"os"

	analyst "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/application"
	analystdomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/domain"
	analystsql "github.com/Dreamcoder08/sipges/apps/api-go/internal/analyst/infrastructure"
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
		return &analyst.Ask{Model: model, Tools: askTools{mcp: tools, tenantID: tenantID}}, nil
	}, nil
}

// toolModel is the configured provider's tool-calling adapter.
func toolModel(settings config.Analyst) analyst.ToolModel {
	if settings.Provider == config.ProviderOpenAICompatible {
		return analystsql.NewOpenAICompatible(settings.Model, os.LookupEnv)
	}
	return analystsql.NewClaude(settings.Model, os.LookupEnv)
}

// askTools implements analyst.ToolRunner over the MCP read tools of one project. Write tools are
// neither offered nor run: the analyst proposes writes, it never makes them.
type askTools struct {
	mcp      integration.MCP
	tenantID string
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
	return specs
}

func (a askTools) Run(ctx context.Context, name string, input json.RawMessage) (analyst.ToolOutput, error) {
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

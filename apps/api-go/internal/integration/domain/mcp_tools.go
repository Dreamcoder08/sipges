package domain

import (
	_ "embed" // the tool descriptors
	"fmt"

	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// ToolKind says what a tool may carry out of SIPGES (mcp-tools.ts).
type ToolKind int

// The kinds of tool.
const (
	// ToolCatalogue is a static catalogue: no tenant data.
	ToolCatalogue ToolKind = iota
	// ToolRead reads tenant data: refused while external AI is off, sanitised and logged otherwise.
	ToolRead
	// ToolWrite creates data and answers only with the id it assigned.
	ToolWrite
)

// The tools.
const (
	ToolListObjectTypes = "list_object_types"
	ToolSearchRecords   = "search_records"
	ToolGetRecord       = "get_record"
	ToolGetLinks        = "get_links"
	ToolGetTimeline     = "get_timeline"
	ToolGetBriefing     = "get_briefing"
	ToolCreateRecord    = "create_record"
	ToolLinkRecords     = "link_records"
)

// Tool is one entry of MCP_TOOLS. Descriptor is toolDescriptor(tool), recorded from TypeScript.
type Tool struct {
	Name       string
	Kind       ToolKind
	Descriptor *records.Object
	input      schema
}

// ParseArguments is the tool's input.safeParse; a non-empty detail means it was refused.
func (t Tool) ParseArguments(v any) (*records.Object, string) { return parseArguments(t.input, v) }

var (
	module  = stringSchema{length{max: 40}}
	modules = optionalSchema{arraySchema{element: module, max: 20}}
	ref     = objectSchema{{"module", module}, {"id", stringSchema{length{min: 1, max: 200}}}}
)

var inputs = []struct {
	name  string
	kind  ToolKind
	input schema
}{
	{ToolListObjectTypes, ToolCatalogue, objectSchema{}},
	{ToolSearchRecords, ToolRead, objectSchema{
		{"query", stringSchema{length{min: 1, max: 200}}},
		{"modules", modules},
		{"limit", defaultSchema{intSchema{1, 50}, float64(10)}},
	}},
	{ToolGetRecord, ToolRead, ref},
	{ToolGetLinks, ToolRead, ref},
	{ToolGetTimeline, ToolRead, objectSchema{
		{"from", defaultSchema{stringSchema{length{max: 10}}, ""}},
		{"to", defaultSchema{stringSchema{length{max: 10}}, ""}},
		{"modules", modules},
		{"limit", defaultSchema{intSchema{1, 200}, float64(50)}},
	}},
	{ToolGetBriefing, ToolRead, ref},
	{ToolCreateRecord, ToolWrite, objectSchema{{"module", module}, {"payload", recordSchema{}}}},
	{ToolLinkRecords, ToolWrite, objectSchema{
		{"link_type", stringSchema{length{max: 40}}},
		{"source", ref},
		{"target", ref},
		{"note", defaultSchema{stringSchema{length{max: 500}}, ""}},
	}},
}

//go:embed mcp_tools.json
var descriptorsJSON []byte

// Tools is MCP_TOOLS, in its order.
var Tools = func() []Tool {
	parsed, err := records.ParseBody(descriptorsJSON)
	list, ok := parsed.([]any)
	if err != nil || !ok || len(list) != len(inputs) {
		panic("integration: mcp_tools.json does not match the tools")
	}
	tools := make([]Tool, len(inputs))
	for i, in := range inputs {
		entry, _ := list[i].(*records.Object)
		write, _ := entry.Get("write")
		value, _ := entry.Get("descriptor")
		descriptor, _ := value.(*records.Object)
		name, _ := descriptor.Get("name")
		if name != in.name || write != (in.kind == ToolWrite) {
			panic(fmt.Sprintf("integration: mcp_tools.json entry %d is not %s", i, in.name))
		}
		tools[i] = Tool{Name: in.name, Kind: in.kind, Descriptor: descriptor, input: in.input}
	}
	return tools
}()

// ToolsFor is toolsFor: write tools only for write keys.
func ToolsFor(p Principal) []Tool {
	out := make([]Tool, 0, len(Tools))
	for _, tool := range Tools {
		if tool.Kind != ToolWrite || p.Access == "write" {
			out = append(out, tool)
		}
	}
	return out
}

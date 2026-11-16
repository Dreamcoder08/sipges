//nolint:misspell // Spanish record modules in synthetic fixtures.
package app

import (
	"encoding/json"
	"testing"

	integration "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/application"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
)

func TestRecordRefsFollowTheAnswerAndSkipWithheldRecords(t *testing.T) {
	t.Parallel()
	// Structs, like the tools' answers: their JSON keeps the field order.
	type ref struct {
		Module   string `json:"module"`
		ID       string `json:"id"`
		Title    string `json:"title,omitempty"`
		Withheld bool   `json:"withheld,omitempty"`
	}
	type link struct {
		Label string `json:"label"`
		Other ref    `json:"other"`
	}
	answer := struct {
		Record ref   `json:"record"`
		Links  []any `json:"links"`
	}{
		Record: ref{Module: "conflictos", ID: "C-1", Title: "Bloqueo de vía"},
		Links: []any{
			link{Label: "involucra", Other: ref{Module: "actores", ID: "A-7", Title: "Comunidad Norte"}},
			ref{Module: "compromisos", ID: "K-3", Withheld: true},
		},
	}
	refs, err := recordRefs(privacy.ExemptPayload[any](answer, privacy.ExemptConstant))
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 2 || refs[0].ID != "C-1" || refs[0].Title != "Bloqueo de vía" || refs[1].Slug != "actores" {
		t.Fatalf("refs = %+v", refs)
	}
}

func TestAskToolsOfferOnlyReadTools(t *testing.T) {
	t.Parallel()
	specs := askTools{}.Specs()
	names := map[string]bool{}
	for _, s := range specs {
		names[s.Name] = true
		if !json.Valid(s.InputSchema) || s.Description == "" {
			t.Fatalf("spec %s: schema %s, description %q", s.Name, s.InputSchema, s.Description)
		}
	}
	for _, want := range []string{"search_records", "get_record", "get_links", "get_timeline", "get_briefing", "list_object_types"} {
		if !names[want] {
			t.Fatalf("missing %s in %v", want, names)
		}
	}
	if names["create_record"] || names["link_records"] {
		t.Fatalf("write tools offered: %v", names)
	}
}

func TestAskToolsRefuseWritesUnknownToolsAndBadArguments(t *testing.T) {
	t.Parallel()
	tools := askTools{tenantID: "ACME/NORTE"}
	cases := map[string]json.RawMessage{
		"create_record": json.RawMessage(`{"module":"conflictos","payload":{}}`),
		"drop_table":    nil,
		"get_record":    json.RawMessage(`{"module":3}`),
	}
	for name, input := range cases {
		out, err := tools.Run(t.Context(), name, input)
		if err != nil || out.OK || out.Refusal == "" {
			t.Fatalf("%s: out = %+v, err = %v", name, out, err)
		}
	}
}

func TestAskToolsRefuseReadsWithoutAGuard(t *testing.T) {
	t.Parallel()
	out, err := askTools{mcp: integration.MCP{}, tenantID: "ACME/NORTE"}.Run(t.Context(), "search_records", json.RawMessage(`{"query":"bloqueo"}`))
	if err != nil || out.OK || out.Refusal != privacy.ExternalAIDisabled {
		t.Fatalf("out = %+v, err = %v", out, err)
	}
}

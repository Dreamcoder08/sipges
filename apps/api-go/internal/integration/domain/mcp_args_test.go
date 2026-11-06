package domain_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// What zod answered to every shape of argument (testdata/mcp.mjs): the detail of the refusal, key
// by key and in order, or the parsed data with its defaults, byte for byte.
func TestArgumentsAnswerAsZod(t *testing.T) {
	raw, err := os.ReadFile("../testdata/mcp.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Zod []struct {
			Tool   string  `json:"tool"`
			Args   string  `json:"args"`
			Data   *string `json:"data"`
			Issues *string `json:"issues"`
		} `json:"zod"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Zod) < 2000 {
		t.Fatalf("only %d cases", len(fixture.Zod))
	}
	tools := map[string]domain.Tool{}
	for _, tool := range domain.Tools {
		tools[tool.Name] = tool
	}
	for _, c := range fixture.Zod {
		args, err := records.ParseBody([]byte(c.Args))
		if err != nil {
			t.Fatalf("%s: %v", c.Args, err)
		}
		parsed, detail := tools[c.Tool].ParseArguments(args)
		if c.Issues != nil {
			if detail != *c.Issues {
				t.Errorf("%s %s:\n got %s\nwant %s", c.Tool, c.Args, detail, *c.Issues)
			}
			continue
		}
		if detail != "" {
			t.Errorf("%s %s: refused: %s", c.Tool, c.Args, detail)
			continue
		}
		if got := string(records.Stringify(parsed)); got != *c.Data {
			t.Errorf("%s %s:\n got %s\nwant %s", c.Tool, c.Args, got, *c.Data)
		}
	}
}

func TestReadKeysSeeNoWriteTool(t *testing.T) {
	if got := len(domain.ToolsFor(domain.Principal{Access: "read"})); got != 6 {
		t.Errorf("read key: %d tools", got)
	}
	if got := len(domain.ToolsFor(domain.Principal{Access: "write"})); got != 8 {
		t.Errorf("write key: %d tools", got)
	}
}

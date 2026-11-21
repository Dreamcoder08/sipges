package domain_test

import (
	"os"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
)

// Parity leaves Go-only tools out by name (apps/parity/src/contexts/mcp.ts, reporting-mcp S8): its
// list must name every one, or a new Go-only tool fails parity for the wrong reason.
func TestParityNamesEveryGoOnlyTool(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("../../../../parity/src/contexts/mcp.ts")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range domain.GoOnlyTools() {
		if !strings.Contains(string(raw), "'"+name+"'") {
			t.Errorf("apps/parity/src/contexts/mcp.ts GO_ONLY_TOOLS does not name %s", name)
		}
	}
}

package wasmengine_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/engines/go/wasmengine"
)

// The analytics module built by `cargo build --release --target wasm32-wasip1 -p
// sipges-analytics-wasm` (override with SIPGES_ANALYTICS_WASM).
const defaultAnalyticsWasm = "../../target/wasm32-wasip1/release/sipges_analytics_wasm.wasm"

// Each analytics fixture file and the op that selects its engine.
var analyticsFixtures = []struct{ file, op string }{
	{"situational.json", "situational"},
	{"strategic.json", "strategic"},
	{"consensus.json", "consensus"},
	{"candidate-links.json", "candidate_links"},
	{"integrated.json", "integrated"},
}

type analyticsCase struct {
	Name    string `json:"name"`
	Request string `json:"request"`
	Value   string `json:"value"`
}

// withOp prepends "op" to a request object's JSON text, keeping the rest of it byte for byte.
func withOp(t *testing.T, op, request string) []byte {
	t.Helper()
	body := strings.TrimSpace(request)
	if !strings.HasPrefix(body, "{") {
		t.Fatalf("request is not a JSON object: %.40q", body)
	}
	rest := strings.TrimSpace(body[1:])
	if rest == "}" {
		return []byte(`{"op":"` + op + `"}`)
	}
	return []byte(`{"op":"` + op + `",` + rest)
}

func TestAnalyticsFixturesMatchTheTypeScriptEnginesThroughWasm(t *testing.T) {
	path := os.Getenv("SIPGES_ANALYTICS_WASM")
	if path == "" {
		path = defaultAnalyticsWasm
	}
	wasm, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		t.Fatalf("read analytics module (build it with `cargo build --release --target wasm32-wasip1 -p sipges-analytics-wasm` in engines/): %v", err)
	}
	ctx := context.Background()
	engine, err := wasmengine.New(ctx, wasm, wasmengine.Options{})
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}
	t.Cleanup(func() { _ = engine.Close(ctx) })
	for _, fixture := range analyticsFixtures {
		t.Run(fixture.op, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join("../../fixtures", fixture.file))
			if err != nil {
				t.Fatalf("read fixtures: %v", err)
			}
			var file struct {
				Cases []analyticsCase `json:"cases"`
			}
			if err := json.Unmarshal(raw, &file); err != nil {
				t.Fatalf("decode fixtures: %v", err)
			}
			if len(file.Cases) < 5 {
				t.Fatalf("expected the full fixture set, got %d cases", len(file.Cases))
			}
			for _, tc := range file.Cases {
				got, err := engine.Invoke(ctx, withOp(t, fixture.op, tc.Request))
				if err != nil {
					t.Fatalf("%s: %v", tc.Name, err)
				}
				if want := `{"ok":true,"value":` + tc.Value + `}`; string(got) != want {
					t.Errorf("%s: response differs from the TypeScript engine (%d vs %d bytes)", tc.Name, len(got), len(want))
				}
			}
		})
	}
}

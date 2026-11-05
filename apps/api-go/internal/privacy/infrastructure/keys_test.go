package infrastructure_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/infrastructure"
)

// The derived project keys hash as createPseudonymKeys does, so a pseudonym computed by either API
// is the same token.
func TestKeysMatchTypeScript(t *testing.T) {
	raw, err := os.ReadFile("../testdata/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Keys [][]string `json:"keys"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Keys) == 0 {
		t.Fatal("no key cases")
	}
	keys := infrastructure.NewKeys([]byte("0123456789abcdef0123456789abcdef"))
	for _, c := range f.Keys {
		if got := keys.MacFor(c[0])(c[1]); got != c[2] {
			t.Errorf("MacFor(%q)(%q) = %s, want %s", c[0], c[1], got, c[2])
		}
	}
}

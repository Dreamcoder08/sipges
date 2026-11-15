package release

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestVersionIsTheRootPackageJSON keeps the one version source: bumping package.json without
// this constant (or the TypeScript SIPGES_VERSION, pinned by apps/api/test/health.test.ts) fails.
func TestVersionIsTheRootPackageJSON(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	var root struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &root); err != nil {
		t.Fatal(err)
	}
	if root.Version == "" || Version != root.Version {
		t.Fatalf("release.Version = %q, root package.json version = %q", Version, root.Version)
	}
}

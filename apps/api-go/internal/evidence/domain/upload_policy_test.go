package domain_test

import (
	"encoding/json"
	"os"
	"slices"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/domain"
)

// fixture is testdata/upload-policy.json, recorded from the TypeScript domain by
// testdata/generate.mjs on synthetic names and bytes.
type fixture struct {
	Allowed    []string                           `json:"allowed"`
	MaxBytes   int                                `json:"max_bytes"`
	Bodies     map[string][]byte                  `json:"-"`
	RawBodies  map[string][]int                   `json:"bodies"`
	Extensions []struct{ Name, Extension string } `json:"extensions"`
	SafeNames  []struct{ Name, Safe string }      `json:"safe_names"`
	Checks     []struct {
		Name, Body string
		Result     struct {
			OK          bool   `json:"ok"`
			Kind        string `json:"kind"`
			SafeName    string `json:"safeName"`
			ContentType string `json:"contentType"`
		}
	} `json:"checks"`
}

func load(t *testing.T) fixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/upload-policy.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	f.Bodies = map[string][]byte{}
	for k, v := range f.RawBodies {
		b := make([]byte, len(v))
		for i, x := range v {
			b[i] = byte(x)
		}
		f.Bodies[k] = b
	}
	if len(f.Checks) == 0 {
		t.Fatal("empty fixture")
	}
	return f
}

func TestAllowedExtensionsMatchTypeScript(t *testing.T) {
	f := load(t)
	if !slices.Equal(domain.AllowedExtensions(), f.Allowed) {
		t.Fatalf("got %v, want %v", domain.AllowedExtensions(), f.Allowed)
	}
}

func TestExtensionOfMatchesTypeScript(t *testing.T) {
	for _, c := range load(t).Extensions {
		if got := domain.ExtensionOf(c.Name); got != c.Extension {
			t.Errorf("ExtensionOf(%q) = %q, want %q", c.Name, got, c.Extension)
		}
	}
}

func TestSafeUploadNameMatchesTypeScript(t *testing.T) {
	for _, c := range load(t).SafeNames {
		if got := domain.SafeUploadName(c.Name); got != c.Safe {
			t.Errorf("SafeUploadName(%q) = %q, want %q", c.Name, got, c.Safe)
		}
	}
}

func TestCheckUploadMatchesTypeScript(t *testing.T) {
	f := load(t)
	for _, c := range f.Checks {
		got, rejection := domain.CheckUpload(c.Name, f.Bodies[c.Body], f.MaxBytes)
		want := c.Result
		switch {
		case want.OK && (rejection != "" || got.SafeName != want.SafeName || got.ContentType != want.ContentType):
			t.Errorf("CheckUpload(%q, %s) = %+v %q, want %+v", c.Name, c.Body, got, rejection, want)
		case !want.OK && string(rejection) != want.Kind:
			t.Errorf("CheckUpload(%q, %s) rejection = %q, want %q", c.Name, c.Body, rejection, want.Kind)
		}
	}
}

func TestDownloadURLEncodesTheIDLikeEncodeURIComponent(t *testing.T) {
	for id, want := range map[string]string{
		"ADJ-0123456789AB": "/system/uploads/ADJ-0123456789AB/download",
		"a b/c?d#e%f":      "/system/uploads/a%20b%2Fc%3Fd%23e%25f/download",
		"!'()*-._~":        "/system/uploads/!'()*-._~/download",
		"ñ😀":               "/system/uploads/%C3%B1%F0%9F%98%80/download",
	} {
		if got := domain.DownloadURL(id); got != want {
			t.Errorf("DownloadURL(%q) = %q, want %q", id, got, want)
		}
	}
}

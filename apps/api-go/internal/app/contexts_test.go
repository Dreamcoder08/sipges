package app

import (
	"errors"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// The expected contexts are the context_<name>.go files themselves, so a new context adds a
// file and never edits a list here.
func TestEveryPortedContextRegistersFromItsOwnFile(t *testing.T) {
	files, err := filepath.Glob("context_*.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("no context files found: %v", err)
	}
	var want []string
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		want = append(want, strings.TrimSuffix(strings.TrimPrefix(f, "context_"), ".go"))
	}
	got := contextNames()
	if len(got) != len(want) {
		t.Fatalf("registered %v, files %v: every context_<name>.go must call registerContext(\"<name>\", ...)", got, want)
	}
	for _, name := range want {
		if !slices.Contains(got, name) {
			t.Fatalf("context %q is not registered; registered: %v", name, got)
		}
	}
	if !slices.IsSorted(got) {
		t.Fatalf("contexts mount out of order: %v", got)
	}
}

func TestRegisteringAContextTwicePanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("registering audit twice did not panic")
		}
	}()
	registerContext("audit", func(Deps) (func(*http.ServeMux), error) { return nil, nil })
}

func TestContextRoutesNamesTheContextThatFailed(t *testing.T) {
	const name = "zz-failing-for-test"
	registerContext(name, func(Deps) (func(*http.ServeMux), error) { return nil, errors.New("broken") })
	defer delete(contexts, name)
	if _, err := contextRoutes(Deps{}); err == nil || err.Error() != name+": broken" {
		t.Fatalf("err = %v", err)
	}
}

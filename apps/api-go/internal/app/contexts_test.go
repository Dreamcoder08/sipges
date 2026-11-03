package app

import (
	"errors"
	"net/http"
	"slices"
	"testing"
)

func TestEveryPortedContextRegistersFromItsOwnFile(t *testing.T) {
	want := []string{"audit", "intelligence", "management", "prevention", "reference", "situations"}
	got := contextNames()
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

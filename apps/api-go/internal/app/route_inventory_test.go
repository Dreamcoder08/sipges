package app_test

import (
	"context"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/cli"
)

// muxPatterns reads every pattern off a real ServeMux. The standard library offers no way to list
// them, and a list kept by hand is the very thing this check exists to catch, so it reads the
// private index. A Go release that moves it fails here, loudly, not silently with an empty list.
func muxPatterns(t *testing.T, mux *http.ServeMux) []string {
	t.Helper()
	index := reflect.ValueOf(mux).Elem().FieldByName("index")
	if !index.IsValid() {
		t.Fatal("http.ServeMux has no index field: update muxPatterns for this Go release")
	}
	segments, multis := index.FieldByName("segments"), index.FieldByName("multis")
	if !segments.IsValid() || !multis.IsValid() {
		t.Fatal("http.ServeMux's index changed shape: update muxPatterns for this Go release")
	}
	seen := map[string]bool{}
	add := func(pattern reflect.Value) {
		text := pattern.Elem().FieldByName("str")
		if !text.IsValid() {
			t.Fatal("http.ServeMux's pattern changed shape: update muxPatterns for this Go release")
		}
		seen[text.String()] = true
	}
	for entries := segments.MapRange(); entries.Next(); {
		for i := range entries.Value().Len() {
			add(entries.Value().Index(i))
		}
	}
	for i := range multis.Len() {
		add(multis.Index(i))
	}
	patterns := make([]string, 0, len(seen))
	for pattern := range seen {
		if pattern != "/" { // the JSON 404, the fallback for everything else
			patterns = append(patterns, pattern)
		}
	}
	slices.Sort(patterns)
	return patterns
}

// servedRoutes builds the real handler with every optional route on. Nothing connects: a pool
// dials on first use, and this test only mounts routes.
func servedRoutes(t *testing.T) []string {
	t.Helper()
	t.Setenv("SIPGES_GOOGLE_CLIENT_ID", "synthetic-client")
	t.Setenv("SIPGES_GOOGLE_CLIENT_SECRET", "synthetic-secret")
	t.Setenv("SIPGES_DATA_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
	pool, err := pgxpool.New(context.Background(), "postgres://synthetic@127.0.0.1:1/synthetic")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var mux *http.ServeMux
	options := app.Options{Routes: func(m *http.ServeMux) { mux = m }}
	if _, err := app.NewHandler(pool, options); err != nil {
		t.Fatal(err)
	}
	return muxPatterns(t, mux)
}

// TestEveryRouteHasACLIPath is the coverage check: the CLI's generic call reaches exactly the
// inventory, so a route missing from it has no CLI path and fails CI here.
func TestEveryRouteHasACLIPath(t *testing.T) {
	routes, err := cli.Routes()
	if err != nil {
		t.Fatal(err)
	}
	inventory := make([]string, 0, len(routes))
	for _, route := range routes {
		inventory = append(inventory, route.Key())
	}
	slices.Sort(inventory)
	served := servedRoutes(t)
	if len(served) < 130 {
		t.Fatalf("read only %d routes off the mux: the walk is broken", len(served))
	}
	var problems []string
	for _, route := range served {
		if _, found := slices.BinarySearch(inventory, route); !found {
			problems = append(problems, "no CLI path, add it to internal/cli/routes.json: "+route)
		}
	}
	for _, route := range inventory {
		if _, found := slices.BinarySearch(served, route); !found {
			problems = append(problems, "in internal/cli/routes.json but not served: "+route)
		}
	}
	if len(problems) > 0 {
		t.Fatal(strings.Join(problems, "\n"))
	}
}

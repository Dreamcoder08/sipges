package application

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// scenario is one entry of ../testdata/fixtures.json: synthetic inputs and the answers of the
// TypeScript routes to them (generate.mjs).
type scenario struct {
	Name   string `json:"name"`
	Now    string `json:"now"`
	Stored *struct {
		Settings  json.RawMessage `json:"settings"`
		UpdatedBy string          `json:"updated_by"`
		UpdatedAt string          `json:"updated_at"`
	} `json:"stored"`
	Records []struct {
		Module  string          `json:"module"`
		ID      string          `json:"id"`
		Payload json.RawMessage `json:"payload"`
	} `json:"records"`
	Settings   json.RawMessage `json:"settings"`
	Situations json.RawMessage `json:"situations"`
}

func TestRoutesAnswerAsTypeScriptOnSyntheticScenarios(t *testing.T) {
	raw, err := os.ReadFile("../testdata/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Scenarios []scenario `json:"scenarios"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Scenarios) == 0 {
		t.Fatal("no scenarios")
	}
	for _, sc := range f.Scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			var stored *domain.Stored
			if sc.Stored != nil {
				settings, err := domain.DecodeObject(sc.Stored.Settings)
				if err != nil {
					t.Fatal(err)
				}
				at, err := time.Parse(time.RFC3339Nano, sc.Stored.UpdatedAt)
				if err != nil {
					t.Fatal(err)
				}
				stored = &domain.Stored{Settings: settings, UpdatedBy: sc.Stored.UpdatedBy, UpdatedAt: at}
			}
			records := make([]domain.SourceRecord, 0, len(sc.Records))
			for _, r := range sc.Records {
				payload, err := domain.DecodeObject(r.Payload)
				if err != nil {
					t.Fatal(err)
				}
				records = append(records, domain.SourceRecord{Module: r.Module, ID: r.ID, Payload: payload})
			}
			now, err := time.Parse(time.RFC3339Nano, sc.Now)
			if err != nil {
				t.Fatal(err)
			}
			sameJSON(t, "settings", Settings(stored), sc.Settings)
			sameJSON(t, "situations", Situations(stored, records, now), sc.Situations)
		})
	}
}

// sameJSON compares got, marshalled, with want as JSON values (key order does not count) and
// reports the first differing paths.
func sameJSON(t *testing.T, label string, got any, want json.RawMessage) {
	t.Helper()
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("%s: %v", label, err)
	}
	var g, w any
	if err := json.Unmarshal(encoded, &g); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatal(err)
	}
	var diffs []string
	diff("", g, w, &diffs)
	if len(diffs) > 0 {
		if len(diffs) > 10 {
			diffs = append(diffs[:10], fmt.Sprintf("… %d more", len(diffs)-10))
		}
		t.Errorf("%s differs from TypeScript:\n%v", label, diffs)
	}
}

func diff(path string, got, want any, out *[]string) {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			*out = append(*out, fmt.Sprintf("%s: got %v, want an object", path, got))
			return
		}
		keys := map[string]bool{}
		for k := range w {
			keys[k] = true
		}
		for k := range g {
			keys[k] = true
		}
		sorted := make([]string, 0, len(keys))
		for k := range keys {
			sorted = append(sorted, k)
		}
		sort.Strings(sorted)
		for _, k := range sorted {
			gv, gok := g[k]
			wv, wok := w[k]
			if gok != wok {
				*out = append(*out, fmt.Sprintf("%s.%s: present in Go %v, in TypeScript %v", path, k, gok, wok))
				continue
			}
			diff(path+"."+k, gv, wv, out)
		}
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			*out = append(*out, fmt.Sprintf("%s: got %v, want %v", path, got, want))
			return
		}
		for i := range w {
			diff(fmt.Sprintf("%s[%d]", path, i), g[i], w[i], out)
		}
	default:
		if !reflect.DeepEqual(got, want) {
			*out = append(*out, fmt.Sprintf("%s: got %#v, want %#v", path, got, want))
		}
	}
}

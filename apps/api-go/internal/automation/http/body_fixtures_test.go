package http

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/domain"
)

type bodyCase struct {
	Raw    string          `json:"raw"`
	Status int             `json:"status"`
	Value  json.RawMessage `json:"value"`
	Detail json.RawMessage `json:"detail"`
}

func loadBodies(t *testing.T) (rules, channels, reads []bodyCase) {
	t.Helper()
	raw, err := os.ReadFile("../testdata/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Rules    []bodyCase `json:"rule_bodies"`
		Channels []bodyCase `json:"channel_bodies"`
		Reads    []bodyCase `json:"read_bodies"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f.Rules, f.Channels, f.Reads
}

func sameJSON(t *testing.T, got any, want json.RawMessage) bool {
	t.Helper()
	b, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var g, w any
	_ = json.Unmarshal(b, &g)
	_ = json.Unmarshal(want, &w)
	return reflect.DeepEqual(g, w)
}

func check[T any](t *testing.T, cases []bodyCase, schema func(any) (T, result), out func(T) any) {
	t.Helper()
	for _, c := range cases {
		value, issues := parse([]byte(c.Raw), schema)
		if (issues == nil) != (c.Status == 200) {
			t.Errorf("%s: issues %v, want status %d %s", c.Raw, issues, c.Status, c.Detail)
			continue
		}
		if issues != nil {
			if !sameJSON(t, issues, c.Detail) {
				b, _ := json.Marshal(issues)
				t.Errorf("%.120s:\n got %s\nwant %s", c.Raw, b, c.Detail)
			}
			continue
		}
		if got := out(value); !sameJSON(t, got, c.Value) {
			b, _ := json.Marshal(got)
			t.Errorf("%.120s: value\n got %s\nwant %s", c.Raw, b, c.Value)
		}
	}
}

func TestBodiesValidateAsTheTypeScriptSchemas(t *testing.T) {
	rules, channels, reads := loadBodies(t)
	check(t, rules, ruleIn, func(in domain.RuleInput) any {
		steps := make([]map[string]any, len(in.Steps))
		for i, s := range in.Steps {
			steps[i] = map[string]any{"kind": s.Kind, "title": s.Title}
			switch s.Kind {
			case "evaluate":
				steps[i]["minimum_level"] = s.MinimumLevel
			case "channel":
				steps[i]["channel_id"] = s.ChannelID
			}
		}
		return map[string]any{"name": in.Name, "enabled": in.Enabled, "module": in.Module, "actions": in.Actions,
			"conditions": in.Conditions, "steps": steps}
	})
	check(t, channels, channelIn, func(in channelInput) any {
		settings := map[string]any{}
		for k, s := range in.Settings {
			if s.IsList {
				settings[k] = s.List
			} else {
				settings[k] = s.Text
			}
		}
		return map[string]any{"kind": in.Kind, "name": in.Name, "settings": settings}
	})
	check(t, reads, readIn, func(in readInput) any {
		if in.All {
			return map[string]any{"all": true}
		}
		return map[string]any{"ids": in.IDs}
	})
}

//nolint:misspell // Spanish module names.
package domain

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// fixtures.json is recorded from the TypeScript domain by ../testdata/generate.mjs.
type fixtureEvent struct {
	AuditID  int64   `json:"auditId"`
	At       string  `json:"at"`
	Module   string  `json:"module"`
	RecordID *string `json:"recordId"`
	Action   string  `json:"action"`
	Detail   string  `json:"detail"`
	Record   *struct {
		Payload json.RawMessage `json:"payload"`
		Marking string          `json:"marking"`
	} `json:"record"`
}

type fixture struct {
	ValidateRule []struct {
		Input struct {
			Module     string      `json:"module"`
			Actions    []string    `json:"actions"`
			Conditions []Condition `json:"conditions"`
			Steps      []Step      `json:"steps"`
		} `json:"input"`
		Error *string `json:"error"`
	} `json:"validate_rule"`
	Retry []struct {
		Attempts int64  `json:"attempts"`
		Minutes  *int64 `json:"minutes"`
	} `json:"retry"`
	Events     []fixtureEvent `json:"events"`
	Operators  []string       `json:"operators"`
	Conditions []struct {
		Event int    `json:"event"`
		Field string `json:"field"`
		Value string `json:"value"`
		Holds string `json:"holds"`
	} `json:"conditions"`
	Rules []struct {
		Enabled    bool        `json:"enabled"`
		Module     string      `json:"module"`
		Actions    []string    `json:"actions"`
		Conditions []Condition `json:"conditions"`
	} `json:"rules"`
	Matches []struct {
		Event   int  `json:"event"`
		Rule    int  `json:"rule"`
		Matches bool `json:"matches"`
	} `json:"matches"`
	Titles []struct {
		Event int    `json:"event"`
		Title string `json:"title"`
		Out   string `json:"out"`
	} `json:"titles"`
	Described []struct {
		Event  int    `json:"event"`
		Detail string `json:"detail"`
		Out    string `json:"out"`
	} `json:"described"`
	Channels []struct {
		Kind     string                     `json:"kind"`
		Settings map[string]json.RawMessage `json:"settings"`
		Out      json.RawMessage            `json:"out"`
	} `json:"channels"`
	PrivateHosts []struct {
		Host    string `json:"host"`
		Private bool   `json:"private"`
	} `json:"private_hosts"`
}

func loadFixture(t *testing.T) fixture {
	t.Helper()
	raw, err := os.ReadFile("../testdata/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func (e fixtureEvent) event(t *testing.T) Event {
	t.Helper()
	at, err := time.Parse(time.RFC3339Nano, e.At)
	if err != nil {
		t.Fatal(err)
	}
	out := Event{AuditID: e.AuditID, At: at, Module: e.Module, RecordID: e.RecordID, Action: e.Action, Detail: e.Detail}
	if e.Record != nil {
		payload, err := records.Parse(e.Record.Payload)
		if err != nil {
			t.Fatal(err)
		}
		out.Record = &EventRecord{Payload: payload, Marking: e.Record.Marking}
	}
	return out
}

func TestConditionsMatchTheTypeScriptDomain(t *testing.T) {
	f := loadFixture(t)
	events := make([]Event, len(f.Events))
	for i, e := range f.Events {
		events[i] = e.event(t)
	}
	for _, c := range f.Conditions {
		for i, op := range f.Operators {
			got := ConditionHolds(events[c.Event], Condition{Field: c.Field, Op: op, Value: c.Value})
			if want := c.Holds[i] == '1'; got != want {
				t.Errorf("event %d: %s %s %q = %v, want %v", c.Event, c.Field, op, c.Value, got, want)
			}
		}
	}
	for _, m := range f.Matches {
		r := f.Rules[m.Rule]
		got := RuleMatches(Rule{ID: 1, Enabled: r.Enabled, Module: r.Module, Actions: r.Actions, Conditions: r.Conditions}, events[m.Event])
		if got != m.Matches {
			t.Errorf("rule %d on event %d = %v, want %v", m.Rule, m.Event, got, m.Matches)
		}
	}
}

func TestTitlesAndDescriptionsMatchTheTypeScriptDomain(t *testing.T) {
	f := loadFixture(t)
	events := make([]Event, len(f.Events))
	for i, e := range f.Events {
		events[i] = e.event(t)
	}
	for _, c := range f.Titles {
		// encoding/json reads the fixture's "\ud83d" as U+FFFD: compare after the same mapping.
		got := RenderTitle(c.Title, events[c.Event])
		if FromUnitsReplacing(Units(got)) != c.Out {
			t.Errorf("event %d %q:\n got %q\nwant %q", c.Event, c.Title, got, c.Out)
		}
	}
	for _, c := range f.Described {
		e := Event{}
		if c.Event >= 0 {
			e = events[c.Event]
		} else {
			e = events[0]
			e.Detail = c.Detail
		}
		if got := DescribeEvent(e); FromUnitsReplacing(Units(got)) != c.Out {
			t.Errorf("describe %d: got %q, want %q", c.Event, got, c.Out)
		}
	}
}

func TestRenderTitleKeepsTheLoneSurrogateASliceLeaves(t *testing.T) {
	title := RenderTitle(strings.Repeat("a", 199)+"😀", Event{})
	if u := Units(title); len(u) != 200 || u[199] != 0xd83d {
		t.Fatalf("got %v", u[190:])
	}
	if got := PGText(title); got != strings.Repeat("a", 199)+"\uFFFD" {
		t.Fatalf("PGText = %q", got)
	}
}

func TestRuleValidationMatchesTheTypeScriptDomain(t *testing.T) {
	f := loadFixture(t)
	known := map[string]bool{"Alertas": true, "Narrativas": true, "Eventos": true, "InteligenciaDigital": true}
	channels := map[int64]bool{3: true}
	for _, c := range f.ValidateRule {
		got := ValidateRule(RuleInput{Name: "R", Enabled: true, Module: c.Input.Module, Actions: c.Input.Actions,
			Conditions: c.Input.Conditions, Steps: c.Input.Steps}, known, channels)
		want := ""
		if c.Error != nil {
			want = *c.Error
		}
		if string(got) != want {
			t.Errorf("%+v: got %q, want %q", c.Input, got, want)
		}
	}
	for _, c := range f.Retry {
		minutes, ok := RetryDelayMinutes(c.Attempts)
		if ok != (c.Minutes != nil) || ok && minutes != *c.Minutes {
			t.Errorf("retry %d: got %d %v", c.Attempts, minutes, ok)
		}
	}
}

func TestChannelValidationMatchesTheTypeScriptDomain(t *testing.T) {
	f := loadFixture(t)
	for _, c := range f.Channels {
		settings := map[string]Setting{}
		for k, raw := range c.Settings {
			var list []string
			if json.Unmarshal(raw, &list) == nil {
				settings[k] = Setting{List: list, IsList: true}
				continue
			}
			var s string
			_ = json.Unmarshal(raw, &s)
			settings[k] = Setting{Text: s}
		}
		config, hint, bad := ValidateChannel(c.Kind, settings)
		var got any = string(bad)
		if bad == "" {
			got = map[string]any{"config": config, "targetHint": hint}
		}
		gotJSON, _ := json.Marshal(got)
		var gotValue, wantValue any
		_ = json.Unmarshal(gotJSON, &gotValue)
		_ = json.Unmarshal(c.Out, &wantValue)
		if !reflect.DeepEqual(gotValue, wantValue) {
			t.Errorf("%s %s:\n got %s\nwant %s", c.Kind, c.Settings, gotJSON, c.Out)
		}
	}
	for _, c := range f.PrivateHosts {
		if got := IsPrivateHost(c.Host); got != c.Private {
			t.Errorf("IsPrivateHost(%q) = %v, want %v", c.Host, got, c.Private)
		}
	}
}

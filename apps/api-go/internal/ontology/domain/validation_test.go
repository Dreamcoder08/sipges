package domain

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// validation.json is recorded from parseJson and the @sipges/contracts schemas by
// ../testdata/validation.mjs.
type validationCase struct {
	Schema string `json:"schema"`
	Raw    string `json:"raw"`
	Status int    `json:"status"`
	Body   string `json:"body"`
}

// parsed is what the TypeScript schema returns, as JSON, for the Go value.
func parsed(t *testing.T, schema, raw string) (any, []Issue) {
	t.Helper()
	body := []byte(raw)
	switch schema {
	case "link":
		v, issues := ParseLinkIn(body)
		out := map[string]any{"link_type": v.LinkType, "source": v.Source, "target": v.Target, "note": v.Note, "evidence": v.Evidence}
		return out, issues
	case "evidence":
		v, issues := ParseEvidenceIn(body)
		return map[string]any{"evidence": v.Evidence}, issues
	case "marking":
		v, issues := ParseMarkingIn(body)
		return map[string]any{"module": v.Module, "id": v.ID, "marking": v.Marking}, issues
	case "neighbourhood":
		v, issues := ParseNeighbourhoodIn(body)
		return map[string]any{"seeds": v.Seeds, "hops": v.Hops, "fields": v.Fields}, issues
	}
	t.Fatalf("unknown schema %q", schema)
	return nil, nil
}

// asJSON round-trips v through encoding/json, so both sides compare as decoded values (a lone
// surrogate escape reads as U+FFFD on both).
func asJSON(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestBodyValidationMatchesTypeScript(t *testing.T) {
	raw, err := os.ReadFile("../testdata/validation.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Cases []validationCase `json:"cases"`
		// Bytes are bodies that are not UTF-8 or carry byte order marks, as hex.
		Bytes []struct {
			validationCase
			Hex string `json:"hex"`
		} `json:"bytes"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cases) < 150 || len(f.Bytes) < 20 {
		t.Fatalf("only %d recorded cases and %d byte bodies", len(f.Cases), len(f.Bytes))
	}
	for _, b := range f.Bytes {
		decoded, err := hex.DecodeString(b.Hex)
		if err != nil {
			t.Fatal(err)
		}
		b.Raw = string(decoded)
		f.Cases = append(f.Cases, b.validationCase)
	}
	for _, c := range f.Cases {
		var want map[string]any
		if err := json.Unmarshal([]byte(c.Body), &want); err != nil {
			t.Fatal(err)
		}
		value, issues := parsed(t, c.Schema, c.Raw)
		if c.Status != 200 {
			got := asJSON(t, map[string]any{"detail": issues})
			if issues == nil || !reflect.DeepEqual(got, asJSON(t, want)) {
				t.Errorf("%s %q:\n got  %v\n want %v", c.Schema, c.Raw, got, want)
			}
			continue
		}
		if issues != nil {
			t.Errorf("%s %q: refused with %v", c.Schema, c.Raw, issues)
			continue
		}
		expected, _ := want["value"].(map[string]any)
		if _, ok := expected["evidence"]; !ok && (c.Schema == "link") {
			expected["evidence"] = nil // optional: absent and null both read as no evidence
		}
		if got := asJSON(t, value); !reflect.DeepEqual(got, asJSON(t, expected)) {
			t.Errorf("%s %q:\n got  %v\n want %v", c.Schema, c.Raw, got, expected)
		}
	}
}

func TestCheckLinkMatchesTypeScript(t *testing.T) {
	raw, err := os.ReadFile("../testdata/validation.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Checks []struct {
			LinkType string  `json:"linkType"`
			Source   Ref     `json:"source"`
			Target   Ref     `json:"target"`
			Out      *string `json:"out"`
		} `json:"checks"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Checks) < 1000 {
		t.Fatalf("only %d recorded checks", len(f.Checks))
	}
	for _, c := range f.Checks {
		want := ""
		if c.Out != nil {
			want = *c.Out
		}
		if got := CheckLink(c.LinkType, c.Source, c.Target); string(got) != want {
			t.Errorf("checkLink(%q, %v, %v) = %q, want %q", c.LinkType, c.Source, c.Target, got, want)
		}
	}
}

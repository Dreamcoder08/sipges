package domain_test

import (
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/reference/domain"
)

func TestIsRegisteredScope(t *testing.T) {
	cases := []struct {
		scope domain.Scope
		want  bool
	}{
		{domain.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-SECHURA"}, true},
		{domain.Scope{CompanyID: "ACME", ProjectID: "PRJ-SECHURA"}, false},
		{domain.Scope{CompanyID: "SIPGES", ProjectID: "NORTE"}, false},
		{domain.Scope{CompanyID: "sipges", ProjectID: "prj-sechura"}, false},
		{domain.Scope{}, false},
	}
	for _, c := range cases {
		if got := domain.IsRegisteredScope(c.scope); got != c.want {
			t.Errorf("IsRegisteredScope(%+v) = %v, want %v", c.scope, got, c.want)
		}
	}
}

const validCoordinates = `{
  "project_id": "P", "project_name": "N", "initiative": "I", "description": "D",
  "crs": {"geometry": "EPSG:4326", "label": "L", "projected_reference": "R", "axis_order": "A"},
  "source": {"organization": "O", "service": "S", "dataset": "D", "consulted_on": "C", "scope": "Scope text"},
  "nominal_area_source": {"label": "L", "scope": "S"},
  "bbox": [-1, -2, 3, 4],
  "summary": {"concession_count": 1, "nominal_area_total_ha": 10, "gis_area_total_ha": 9.5},
  "concessions": [{
    "code": "C1", "name": "N1", "nominal_area_ha": 10, "gis_area_ha": 9.5, "substance": "S",
    "holder": "H", "department": "D", "province": "P", "district": "Di", "mining_zone": "M",
    "centroid": {"longitude": -1, "latitude": -2, "method": "m"},
    "bbox": [-1, -2, 3, 4],
    "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]},
    "extra": "stripped"
  }],
  "extra": true
}`

func TestParseProjectCoordinatesAcceptsTheContract(t *testing.T) {
	got, err := domain.ParseProjectCoordinates([]byte(validCoordinates))
	if err != nil {
		t.Fatal(err)
	}
	if got.Source.Scope != "Scope text" || len(got.Concessions) != 1 || got.Bbox[3] != 4 {
		t.Fatalf("unexpected value %+v", got)
	}
	if ring := got.Concessions[0].Geometry.Coordinates[0]; len(ring) != 4 || ring[1][0] != 1 {
		t.Fatalf("unexpected ring %v", ring)
	}
}

// Each mutation breaks one rule of ProjectCoordinates in packages/contracts/src/reference.ts,
// which the TypeScript readers enforce with .parse (an invalid file is an error, never data).
func TestParseProjectCoordinatesRejectsWhatTheContractRejects(t *testing.T) {
	cases := map[string][2]string{
		"missing field":         {`"project_name": "N", `, ``},
		"null string":           {`"initiative": "I"`, `"initiative": null`},
		"wrong type":            {`"description": "D"`, `"description": 1`},
		"other geometry crs":    {`"EPSG:4326"`, `"EPSG:32717"`},
		"short bbox":            {`"bbox": [-1, -2, 3, 4],` + "\n  \"summary\"", `"bbox": [-1, -2, 3],` + "\n  \"summary\""},
		"long bbox":             {`"bbox": [-1, -2, 3, 4],` + "\n  \"summary\"", `"bbox": [-1, -2, 3, 4, 5],` + "\n  \"summary\""},
		"three-number point":    {`[[[0, 0], [1, 0]`, `[[[0, 0, 0], [1, 0]`},
		"ring under 4 points":   {`[[[0, 0], [1, 0], [1, 1], [0, 0]]]`, `[[[0, 0], [1, 0], [0, 0]]]`},
		"no ring":               {`[[[0, 0], [1, 0], [1, 1], [0, 0]]]`, `[]`},
		"other geometry type":   {`"Polygon"`, `"MultiPolygon"`},
		"missing nested field":  {`"latitude": -2, `, ``},
		"concessions not array": {`"concessions": [{`, `"concessions": {"x": {`},
		"not an object":         {validCoordinates, `[]`},
		"null document":         {validCoordinates, `null`},
	}
	for name, edit := range cases {
		t.Run(name, func(t *testing.T) {
			raw := strings.Replace(validCoordinates, edit[0], edit[1], 1)
			if raw == validCoordinates {
				t.Fatal("mutation did not apply")
			}
			if _, err := domain.ParseProjectCoordinates([]byte(raw)); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestParseCanonicalEntities(t *testing.T) {
	const valid = `{"A": {"canonical_name": "C", "short_name": "S", "entity_type": "T", "territory": "R", "note": "N", "x": 1}}`
	got, err := domain.ParseCanonicalEntities([]byte(valid))
	if err != nil {
		t.Fatal(err)
	}
	if got["A"].CanonicalName != "C" || len(got) != 1 {
		t.Fatalf("unexpected value %+v", got)
	}
	empty, err := domain.ParseCanonicalEntities([]byte(`{}`))
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("an empty record is valid and non-nil: %v %v", empty, err)
	}
	for _, raw := range []string{
		`{"A": {"canonical_name": "C", "short_name": "S", "entity_type": "T", "territory": "R"}}`,
		`{"A": null}`,
		`{"A": "text"}`,
		`[]`,
		`null`,
	} {
		if _, err := domain.ParseCanonicalEntities([]byte(raw)); err == nil {
			t.Errorf("expected an error for %s", raw)
		}
	}
}

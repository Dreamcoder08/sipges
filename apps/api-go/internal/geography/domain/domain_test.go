package domain_test

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/domain"
)

// Ported from apps/api/test/geography/geography.test.ts and influence.test.ts (domain parts) and
// the GeographyQuery/GeographyPolygon rules of packages/contracts/src/geography.ts. Coordinates
// are synthetic.

func ring(points ...[2]float64) []domain.Point {
	out := make([]domain.Point, len(points))
	for i, p := range points {
		out[i] = domain.Point(p)
	}
	return out
}

var holed = domain.Polygon{Coordinates: [][]domain.Point{
	ring([2]float64{0, 0}, [2]float64{4, 0}, [2]float64{4, 4}, [2]float64{0, 4}, [2]float64{0, 0}),
	ring([2]float64{1, 1}, [2]float64{1, 2}, [2]float64{2, 2}, [2]float64{2, 1}, [2]float64{1, 1}),
}}

// square is a synthetic 0.01° square near Sechura (influence.test.ts).
var square = domain.Polygon{Coordinates: [][]domain.Point{ring(
	[2]float64{-80.9, -5.6}, [2]float64{-80.89, -5.6}, [2]float64{-80.89, -5.59},
	[2]float64{-80.9, -5.59}, [2]float64{-80.9, -5.6})}}

func TestPointInPolygonExcludesHolesAndIncludesBoundaries(t *testing.T) {
	for _, c := range []struct {
		p    domain.Point
		want bool
	}{
		{domain.Point{1.5, 1.5}, false}, // inside the hole
		{domain.Point{0, 2}, true},      // on the shell
		{domain.Point{1, 1.5}, true},    // on the hole's edge
		{domain.Point{3, 3}, true},
		{domain.Point{5, 5}, false},
		{domain.Point{4, 4 + 1e-11}, true}, // within the boundary tolerance
	} {
		if got := domain.PointInPolygon(c.p, holed); got != c.want {
			t.Errorf("PointInPolygon(%v) = %v, want %v", c.p, got, c.want)
		}
	}
}

func TestIntersects(t *testing.T) {
	inHole := domain.Polygon{Coordinates: [][]domain.Point{ring(
		[2]float64{1.2, 1.2}, [2]float64{1.8, 1.2}, [2]float64{1.8, 1.8}, [2]float64{1.2, 1.8}, [2]float64{1.2, 1.2})}}
	crossing := domain.Polygon{Coordinates: [][]domain.Point{ring( // a cross: no vertex inside the other
		[2]float64{-1, 1.5}, [2]float64{5, 1.5}, [2]float64{5, 1.6}, [2]float64{-1, 1.6}, [2]float64{-1, 1.5})}}
	bar := domain.Polygon{Coordinates: [][]domain.Point{ring(
		[2]float64{2.5, -1}, [2]float64{2.6, -1}, [2]float64{2.6, 5}, [2]float64{2.5, 5}, [2]float64{2.5, -1})}}
	far := domain.Polygon{Coordinates: [][]domain.Point{ring(
		[2]float64{10, 10}, [2]float64{11, 10}, [2]float64{11, 11}, [2]float64{10, 10})}}
	if domain.Intersects(inHole, holed) {
		t.Error("a polygon inside a hole intersects")
	}
	if !domain.Intersects(bar, holed) || !domain.Intersects(holed, bar) {
		t.Error("a bar across the shell does not intersect")
	}
	if !domain.Intersects(crossing, bar) {
		t.Error("crossing edges with no vertex inside do not intersect")
	}
	if domain.Intersects(far, holed) {
		t.Error("disjoint polygons intersect")
	}
}

const degree = 111_195 // one degree of latitude on the mean sphere, metres

func TestDistanceToPolygon(t *testing.T) {
	if d := domain.DistanceToPolygon(domain.Point{-80.895, -5.595}, square); d != 0 {
		t.Fatalf("inside: %v", d)
	}
	if d := domain.DistanceToPolygon(domain.Point{-80.895, -5.58}, square); math.Abs(d-0.01*degree) > 5 {
		t.Fatalf("north: %v", d)
	}
	east := 0.01 * degree * math.Cos(5.58*math.Pi/180)
	if d := domain.DistanceToPolygon(domain.Point{-80.88, -5.58}, square); math.Abs(d-math.Hypot(east, 0.01*degree)) > 5 {
		t.Fatalf("corner: %v", d)
	}
}

func TestJSHelpers(t *testing.T) {
	for in, want := range map[float64]float64{0.49999999999999994: 0, 0.5: 1, 2.5: 3, 1099.4: 1099, 3: 3} {
		if got := domain.Round(in); got != want {
			t.Errorf("Round(%v) = %v, want %v", in, got, want)
		}
	}
	for in, want := range map[float64]string{
		1: "1", math.Copysign(0, -1): "0", 1e21: "1e+21", 1.5e-7: "1.5e-7", 123456789012: "123456789012", 0.1: "0.1",
		math.Inf(1): "Infinity", math.Inf(-1): "-Infinity", math.NaN(): "NaN",
	} {
		if got := domain.FormatNumber(in); got != want {
			t.Errorf("FormatNumber(%v) = %q, want %q", in, got, want)
		}
	}
	if got := domain.Trim("\u00a0\ufeff x \u2028\t"); got != "x" {
		t.Errorf("Trim = %q", got)
	}
	if got := domain.Trim("\u0085x"); got != "\u0085x" {
		t.Errorf("Trim removed NEL, which JavaScript keeps: %q", got)
	}
	b, err := json.Marshal([]domain.Number{domain.Number(math.Copysign(0, -1)), domain.Number(math.Inf(1)), 2.5})
	if err != nil || string(b) != "[0,null,2.5]" {
		t.Errorf("Number JSON = %s, %v", b, err)
	}
}

// decode reads a JSON literal as request bodies and payloads are read.
func decode(t *testing.T, s string) any {
	t.Helper()
	v, err := domain.DecodeJSON([]byte(s))
	if err != nil {
		t.Fatalf("decode %s: %v", s, err)
	}
	return v
}

const unit = `{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}`

func TestParseQuery(t *testing.T) {
	valid := map[string]string{
		"bbox":                        `{"layerId":0,"bbox":[0,0,1,1]}`,
		"bbox of exactly 5°":          `{"layerId":10000,"bbox":[-80,-10,-75,-5]}`,
		"polygon":                     `{"layerId":3,"polygon":` + unit + `}`,
		"service":                     `{"serviceId":"SERV_REINFO","layerId":0,"bbox":[0,0,1,1]}`,
		"integral float layer":        `{"layerId":1.0,"bbox":[0,0,1,1]}`,
		"concession and influence":    `{"layerId":0,"polygon":` + unit + `,"concessionCode":" C1 ","influenceMeters":20000}`,
		"zero influence without area": `{"layerId":0,"bbox":[0,0,1,1],"influenceMeters":0}`,
		"two disjoint holes": `{"layerId":0,"polygon":{"type":"Polygon","coordinates":[[[0,0],[4,0],[4,4],[0,4],[0,0]],` +
			`[[1,1],[1,2],[2,2],[2,1],[1,1]],[[3,3],[3,3.5],[3.5,3.5],[3.5,3],[3,3]]]}}`,
	}
	for name, body := range valid {
		t.Run("valid "+name, func(t *testing.T) {
			if _, ok := domain.ParseQuery(decode(t, body)); !ok {
				t.Fatalf("refused %s", body)
			}
		})
	}
	q, _ := domain.ParseQuery(decode(t, valid["concession and influence"]))
	if q.ServiceID != "SERV_CATASTRO_MINERO" || q.ConcessionCode != "C1" || q.InfluenceMeters != 20000 || q.Polygon == nil {
		t.Fatalf("parsed %+v", q)
	}
	invalid := map[string]string{
		"array":                       `[]`,
		"null":                        `null`,
		"unknown key (url)":           `{"layerId":0,"bbox":[0,0,1,1],"url":"https://evil.test"}`,
		"too wide":                    `{"layerId":0,"bbox":[0,0,100,80]}`,
		"5.0001° wide":                `{"layerId":0,"bbox":[0,0,5.0001,1]}`,
		"reversed":                    `{"layerId":0,"bbox":[4,0,0,4]}`,
		"flat":                        `{"layerId":0,"bbox":[0,0,1,0]}`,
		"neither":                     `{"layerId":0}`,
		"both":                        `{"layerId":0,"bbox":[0,0,1,1],"polygon":` + unit + `}`,
		"bbox of 5 numbers":           `{"layerId":0,"bbox":[0,0,1,1,1]}`,
		"bbox out of range":           `{"layerId":0,"bbox":[0,0,1,91]}`,
		"bbox null":                   `{"layerId":0,"bbox":null,"polygon":` + unit + `}`,
		"bbox string":                 `{"layerId":0,"bbox":["0",0,1,1]}`,
		"no layer":                    `{"bbox":[0,0,1,1]}`,
		"fractional layer":            `{"layerId":1.5,"bbox":[0,0,1,1]}`,
		"negative layer":              `{"layerId":-1,"bbox":[0,0,1,1]}`,
		"layer too large":             `{"layerId":10001,"bbox":[0,0,1,1]}`,
		"layer string":                `{"layerId":"0","bbox":[0,0,1,1]}`,
		"infinite layer":              `{"layerId":1e400,"bbox":[0,0,1,1]}`,
		"unknown service":             `{"serviceId":"SERV_OTRO","layerId":0,"bbox":[0,0,1,1]}`,
		"null service":                `{"serviceId":null,"layerId":0,"bbox":[0,0,1,1]}`,
		"concession without area":     `{"layerId":0,"bbox":[0,0,1,1],"concessionCode":"C1"}`,
		"influence without area":      `{"layerId":0,"bbox":[0,0,1,1],"influenceMeters":10}`,
		"blank concession":            `{"layerId":0,"polygon":` + unit + `,"concessionCode":"   "}`,
		"long concession":             `{"layerId":0,"polygon":` + unit + `,"concessionCode":"` + strings.Repeat("😀", 51) + `"}`,
		"influence too large":         `{"layerId":0,"polygon":` + unit + `,"influenceMeters":20001}`,
		"fractional influence":        `{"layerId":0,"polygon":` + unit + `,"influenceMeters":1.5}`,
		"polygon wider than 5°":       `{"layerId":0,"polygon":{"type":"Polygon","coordinates":[[[0,0],[6,0],[6,1],[0,1],[0,0]]]}}`,
		"self intersecting (bow tie)": `{"layerId":0,"polygon":{"type":"Polygon","coordinates":[[[0,0],[3,3],[0,3],[2,0],[0,0]]]}}`,
		"touching self intersection":  `{"layerId":0,"polygon":{"type":"Polygon","coordinates":[[[0,0],[2,0],[2,2],[1,1],[0,2],[1,1],[0,0]]]}}`,
		"hole outside the shell": `{"layerId":0,"polygon":{"type":"Polygon","coordinates":[[[0,0],[4,0],[4,4],[0,4],[0,0]],` +
			`[[4.1,4.1],[4.5,4.1],[4.5,4.5],[4.1,4.5],[4.1,4.1]]]}}`,
		"overlapping holes": `{"layerId":0,"polygon":{"type":"Polygon","coordinates":[[[0,0],[4,0],[4,4],[0,4],[0,0]],` +
			`[[1,1],[1,2],[2,2],[2,1],[1,1]],[[1.5,1.5],[1.5,2.5],[2.5,2.5],[2.5,1.5],[1.5,1.5]]]}}`,
		"open ring":           `{"layerId":0,"polygon":{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1]]]}}`,
		"ring without area":   `{"layerId":0,"polygon":{"type":"Polygon","coordinates":[[[0,0],[1,1],[2,2],[0,0]]]}}`,
		"ring of 3 positions": `{"layerId":0,"polygon":{"type":"Polygon","coordinates":[[[0,0],[1,0],[0,0]]]}}`,
		"3D position":         `{"layerId":0,"polygon":{"type":"Polygon","coordinates":[[[0,0,9],[1,0],[1,1],[0,0]]]}}`,
		"not a Polygon":       `{"layerId":0,"polygon":{"type":"MultiPolygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}}`,
		"extra polygon key":   `{"layerId":0,"polygon":{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]],"crs":1}}`,
		"no rings":            `{"layerId":0,"polygon":{"type":"Polygon","coordinates":[]}}`,
		"17 rings": `{"layerId":0,"polygon":{"type":"Polygon","coordinates":[` +
			strings.TrimSuffix(strings.Repeat(`[[0,0],[1,0],[1,1],[0,0]],`, 17), ",") + `]}}`,
		"latitude out of range": `{"layerId":0,"polygon":{"type":"Polygon","coordinates":[[[0,90],[1,90],[1,91],[0,90]]]}}`,
	}
	for name, body := range invalid {
		t.Run("invalid "+name, func(t *testing.T) {
			if q, ok := domain.ParseQuery(decode(t, body)); ok {
				t.Fatalf("accepted %s as %+v", body, q)
			}
		})
	}
	t.Run("501 positions", func(t *testing.T) {
		distinct := make([]string, 0, 500)
		for i := range 500 {
			a := float64(i) * 2 * math.Pi / 500
			distinct = append(distinct, "["+domain.FormatNumber(math.Cos(a))+","+domain.FormatNumber(math.Sin(a))+"]")
		}
		polygon := func(points []string) string {
			return `{"layerId":0,"polygon":{"type":"Polygon","coordinates":[[` + strings.Join(points, ",") + `]]}}`
		}
		body := polygon(append(distinct[:500:500], distinct[0]))
		if _, ok := domain.ParseQuery(decode(t, body)); ok {
			t.Fatal("accepted 501 positions")
		}
		if _, ok := domain.ParseQuery(decode(t, polygon(append(distinct[:499:499], distinct[0])))); !ok {
			t.Fatal("refused 500 positions")
		}
	})
}

func TestDecodeJSON(t *testing.T) {
	v := decode(t, "\ufeff{\"a\":1e400,\"b\":[1.0,-0],\"a\":2}")
	m := v.(map[string]any)
	if m["a"] != 2.0 {
		t.Fatalf("the last duplicate wins: %v", m["a"])
	}
	if v := decode(t, `[1e400]`).([]any)[0].(float64); !math.IsInf(v, 1) {
		t.Fatalf("1e400 = %v, want +Inf as JSON.parse", v)
	}
	for _, bad := range []string{``, ` `, `{"a":1} x`, `{`, `nope`} {
		if _, err := domain.DecodeJSON([]byte(bad)); err == nil {
			t.Errorf("decoded %q", bad)
		}
	}
}

//nolint:misspell // Spanish evidence and reasons are compared byte for byte.
package application_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/domain"
)

// Ported from apps/api/test/geography/geography.test.ts (relateRecords), influence.test.ts (area
// of influence) and http.test.ts (scope carried into the reader). Records are synthetic.

func polygon(t *testing.T, s string) domain.Polygon {
	t.Helper()
	v, err := domain.DecodeJSON([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	p, ok := domain.ParsePolygon(v)
	if !ok {
		t.Fatalf("invalid polygon %s", s)
	}
	return p
}

func records(t *testing.T, module string, items ...string) application.ModuleRecords {
	t.Helper()
	out := application.ModuleRecords{Module: module}
	for _, item := range items {
		id, payload, _ := strings.Cut(item, "=")
		v, err := domain.DecodeJSON([]byte(payload))
		if err != nil {
			t.Fatal(err)
		}
		out.Records = append(out.Records, application.Record{ID: id, Payload: v.(map[string]any)})
	}
	return out
}

const holed = `{"type":"Polygon","coordinates":[[[0,0],[4,0],[4,4],[0,4],[0,0]],[[1,1],[1,2],[2,2],[2,1],[1,1]]]}`

const square = `{"type":"Polygon","coordinates":[[[-80.9,-5.6],[-80.89,-5.6],[-80.89,-5.59],[-80.9,-5.59],[-80.9,-5.6]]]}`

func asJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRelateRecordsNeverGeocodesNames(t *testing.T) {
	rel := application.RelateRecords([]application.ModuleRecords{records(t, "Eventos",
		`name={"Territorio":"Sechura"}`,
		`point={"Longitud":3,"Latitud":3}`,
		`ref={"Concesion_Codigo":"C1","Concesion_Fuente":"acta 4"}`,
	)}, polygon(t, holed), "C1")
	if got := asJSON(t, rel.Related); got != `[{"id":"point","module":"Eventos","relationship":"geometry","evidence":"Coordenadas explícitas WGS84","distanceMeters":0},`+
		`{"id":"ref","module":"Eventos","relationship":"explicit-reference","evidence":"acta 4"}]` {
		t.Fatalf("related %s", got)
	}
	if got := asJSON(t, rel.Unlocated); got != `[{"id":"name","module":"Eventos","reason":"Sin geometría WGS84 válida; Territorio no se geocodifica"},`+
		`{"id":"ref","module":"Eventos","reason":"Sin geometría WGS84 válida; Territorio no se geocodifica"}]` {
		t.Fatalf("unlocated %s", got)
	}
}

func TestRelateRecordsReadsStrictDecimalsAndPolygons(t *testing.T) {
	rel := application.RelateRecords([]application.ModuleRecords{records(t, "Eventos",
		`form={"Longitud":" 3.0 ","Latitud":"+3."}`,
		`junk={"Longitud":"3 west","Latitud":"3"}`,
		`hex={"Longitud":"0x3","Latitud":"3"}`,
		`hole={"geometry":{"type":"Polygon","coordinates":[[[1.2,1.2],[1.8,1.2],[1.8,1.8],[1.2,1.8],[1.2,1.2]]]}}`,
		`poly={"Geometria":{"type":"Polygon","coordinates":[[[3,3],[5,3],[5,5],[3,5],[3,3]]]}}`,
		`geopoint={"geometry":{"type":"Point","coordinates":[3.5,0.5]}}`,
		`outside={"Longitud":10,"Latitud":10}`,
		`bad-range={"Longitud":200,"Latitud":3}`,
	)}, polygon(t, holed), "")
	ids := func(items []application.Related) (out []string) {
		for _, i := range items {
			out = append(out, i.ID+":"+i.Evidence)
		}
		return out
	}
	if got := strings.Join(ids(rel.Related), "|"); got != "form:Coordenadas explícitas WGS84|poly:GeoJSON Polygon WGS84|geopoint:Coordenadas explícitas WGS84" {
		t.Fatalf("related %s", got)
	}
	var unlocated []string
	for _, u := range rel.Unlocated {
		unlocated = append(unlocated, u.ID)
	}
	if got := strings.Join(unlocated, ","); got != "junk,hex,bad-range" {
		t.Fatalf("unlocated %s", got)
	}
	if len(rel.Outside) != 1 || rel.Outside[0].ID != "outside" || rel.Outside[0].At != (domain.Point{10, 10}) {
		t.Fatalf("outside %+v", rel.Outside)
	}
}

func TestRelateRecordsCutsLongSources(t *testing.T) {
	long := strings.Repeat("a", 999) + "😀b"
	rel := application.RelateRecords([]application.ModuleRecords{records(t, "Actores",
		`r={"Concesion_Codigo":"C1","Concesion_Fuente":"`+long+`"}`,
		`blank={"Concesion_Codigo":"C1","Concesion_Fuente":"  "}`,
		`other={"Concesion_Codigo":"C2","Concesion_Fuente":"x"}`)}, polygon(t, holed), "C1")
	if len(rel.Related) != 1 || rel.Related[0].Evidence != strings.Repeat("a", 999) {
		t.Fatalf("related %+v", rel.Related)
	}
}

type fakeGateway struct {
	calls int
	err   error
}

func (g *fakeGateway) Catalogue(context.Context) application.Catalogue {
	return application.Catalogue{}
}

func (g *fakeGateway) Query(context.Context, domain.Query) (application.Official, error) {
	g.calls++
	return application.Official{Features: []application.Feature{}, Source: "INGEMMET"}, g.err
}

func query(t *testing.T, body string) domain.Query {
	t.Helper()
	v, err := domain.DecodeJSON([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	q, ok := domain.ParseQuery(v)
	if !ok {
		t.Fatalf("invalid query %s", body)
	}
	return q
}

func influenceReader(_ context.Context, modules []string) ([]application.ModuleRecords, error) {
	if strings.Join(modules, ",") != "Eventos,Demandas,Actores,Narrativas,Reportes" {
		return nil, errors.New("unexpected modules")
	}
	return []application.ModuleRecords{{Module: "Eventos", Records: []application.Record{
		{ID: "EV-IN", Payload: map[string]any{"Longitud": -80.895, "Latitud": -5.595}},
		{ID: "EV-5KM", Payload: map[string]any{"Longitud": -80.895, "Latitud": -5.545}},
		{ID: "EV-1KM", Payload: map[string]any{"Longitud": -80.895, "Latitud": -5.581}},
		{ID: "EV-NAME", Payload: map[string]any{"Territorio": "Sechura"}},
		{ID: "EV-REF", Payload: map[string]any{"Longitud": -80.895, "Latitud": -5.585,
			"Concesion_Codigo": "C1", "Concesion_Fuente": "Resolución sintética"}},
		{ID: "EV-2KM", Payload: map[string]any{"Longitud": -80.895, "Latitud": -5.572}},
	}}}, nil
}

func TestQueryAddsAnAreaOfInfluenceNearestFirst(t *testing.T) {
	svc := application.Service{Gateway: &fakeGateway{}, Spatial: application.Geodesic{}}
	res, err := svc.Query(t.Context(), query(t, `{"layerId":0,"polygon":`+square+`,"concessionCode":"C1","influenceMeters":3000}`), influenceReader)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, r := range res.Related {
		got = append(got, r.ID+":"+r.Relationship)
	}
	if strings.Join(got, ",") != "EV-IN:geometry,EV-REF:explicit-reference,EV-1KM:proximity,EV-2KM:proximity" {
		t.Fatalf("related %v", got)
	}
	near := res.Related[2]
	if near.DistanceMeters == nil || *near.DistanceMeters < 900 || *near.DistanceMeters > 1100 ||
		near.Evidence != "Coordenadas explícitas a "+domain.FormatNumber(*near.DistanceMeters)+" m del límite oficial (aproximación geodésica)" {
		t.Fatalf("proximity %+v", near)
	}
	if got := asJSON(t, res.Influence); got != `{"meters":3000,"engine":"geodesic"}` {
		t.Fatalf("influence %s", got)
	}
	if len(res.Unlocated) != 1 || res.Unlocated[0].ID != "EV-NAME" {
		t.Fatalf("unlocated %+v", res.Unlocated)
	}
}

func TestQueryWithoutInfluenceKeepsTheStrictRelation(t *testing.T) {
	svc := application.Service{Gateway: &fakeGateway{}, Spatial: application.Geodesic{}}
	res, err := svc.Query(t.Context(), query(t, `{"layerId":0,"polygon":`+square+`}`), influenceReader)
	if err != nil {
		t.Fatal(err)
	}
	b := asJSON(t, res)
	if !strings.HasPrefix(b, `{"features":[],"truncated":false,"source":"INGEMMET","related":[{"id":"EV-IN"`) || strings.Contains(b, "influence") {
		t.Fatalf("result %s", b)
	}
}

func TestQueryWithABoundingBoxReadsNoRecords(t *testing.T) {
	svc := application.Service{Gateway: &fakeGateway{}, Spatial: application.Geodesic{}}
	res, err := svc.Query(t.Context(), query(t, `{"layerId":0,"bbox":[0,0,1,1]}`),
		func(context.Context, []string) ([]application.ModuleRecords, error) {
			t.Fatal("records read without a polygon")
			return nil, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	if got := asJSON(t, res); got != `{"features":[],"truncated":false,"source":"INGEMMET","related":[],"unlocated":[]}` {
		t.Fatalf("result %s", got)
	}
}

func TestQueryReportsGatewayAndReaderFailures(t *testing.T) {
	failing := application.Service{Gateway: &fakeGateway{err: errors.New("timeout")}, Spatial: application.Geodesic{}}
	if _, err := failing.Query(t.Context(), query(t, `{"layerId":0,"bbox":[0,0,1,1]}`), influenceReader); err == nil {
		t.Fatal("gateway failure ignored")
	}
	svc := application.Service{Gateway: &fakeGateway{}, Spatial: application.Geodesic{}}
	_, err := svc.Query(t.Context(), query(t, `{"layerId":0,"polygon":`+square+`}`),
		func(context.Context, []string) ([]application.ModuleRecords, error) { return nil, errors.New("rls") })
	if err == nil {
		t.Fatal("reader failure ignored")
	}
}

// pointsEngine answers fixed distances, as PostGIS would, including one it cannot measure.
type pointsEngine map[string]float64

func (e pointsEngine) Distances(_ context.Context, _ domain.Polygon, points []application.SpatialPoint) (string, map[string]float64) {
	out := map[string]float64{}
	for _, p := range points {
		if d, ok := e[p.Key]; ok {
			out[p.Key] = d
		}
	}
	return "postgis", out
}

func TestQueryLabelsPostGISAndDropsUnmeasuredRecords(t *testing.T) {
	svc := application.Service{Gateway: &fakeGateway{}, Spatial: pointsEngine{"Eventos\x00EV-1KM": 1099.5, "Eventos\x00EV-5KM": 2000.49999999}}
	res, err := svc.Query(t.Context(), query(t, `{"layerId":0,"polygon":`+square+`,"influenceMeters":5000}`), influenceReader)
	if err != nil {
		t.Fatal(err)
	}
	if got := asJSON(t, res.Related[1:]); got != `[{"id":"EV-1KM","module":"Eventos","relationship":"proximity","evidence":"Coordenadas explícitas a 1100 m del límite oficial (PostGIS, elipsoide WGS84)","distanceMeters":1100},`+
		`{"id":"EV-5KM","module":"Eventos","relationship":"proximity","evidence":"Coordenadas explícitas a 2000 m del límite oficial (PostGIS, elipsoide WGS84)","distanceMeters":2000}]` {
		t.Fatalf("related %s", got)
	}
	if got := asJSON(t, res.Influence); got != `{"meters":5000,"engine":"postgis"}` {
		t.Fatalf("influence %s", got)
	}
}

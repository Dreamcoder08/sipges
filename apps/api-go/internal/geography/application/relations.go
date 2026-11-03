package application

import (
	"math"
	"regexp"
	"strconv"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/domain"
)

// Located is a record located by a point outside the polygon: a candidate for the area of
// influence.
type Located struct {
	Module string
	ID     string
	At     domain.Point
}

// Relations is what RelateRecords finds.
type Relations struct {
	Related   []Related
	Unlocated []Unlocated
	Outside   []Located
}

const unlocatedReason = "Sin geometría WGS84 válida; Territorio no se geocodifica"

var decimal = regexp.MustCompile(`^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$`)

// coordinate is relations.ts coordinate(): a JSON number, or a strict decimal string.
func coordinate(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		if s := domain.Trim(x); decimal.MatchString(s) {
			f, _ := strconv.ParseFloat(s, 64) // out of range gives ±Inf, as Number()
			return f
		}
	}
	return math.NaN()
}

func finitePoint(lon, lat float64) (domain.Point, bool) {
	ok := !math.IsNaN(lon) && !math.IsInf(lon, 0) && !math.IsNaN(lat) && !math.IsInf(lat, 0) &&
		math.Abs(lon) <= 180 && math.Abs(lat) <= 90
	return domain.Point{lon, lat}, ok
}

// geoJSONPoint is a {"type":"Point","coordinates":[lon,lat]} with finite WGS84 numbers.
func geoJSONPoint(v any) (domain.Point, bool) {
	m, ok := v.(map[string]any)
	if !ok || m["type"] != "Point" {
		return domain.Point{}, false
	}
	c, ok := m["coordinates"].([]any)
	if !ok || len(c) != 2 {
		return domain.Point{}, false
	}
	lon, okLon := c[0].(float64)
	lat, okLat := c[1].(float64)
	if !okLon || !okLat {
		return domain.Point{}, false
	}
	return finitePoint(lon, lat)
}

// RelateRecords is relateRecords (application/relations.ts). Names alone never establish
// geometry; references require the concession code and a documented source.
func RelateRecords(records []ModuleRecords, polygon domain.Polygon, code string) Relations {
	out := Relations{Related: []Related{}, Unlocated: []Unlocated{}}
	for _, mr := range records {
		for _, record := range mr.Records {
			p := record.Payload
			raw := p["geometry"]
			if raw == nil {
				raw = p["Geometria"]
			}
			shape, isPolygon := domain.ParsePolygon(raw)
			point, isPoint := finitePoint(coordinate(p["Longitud"]), coordinate(p["Latitud"]))
			if !isPoint {
				point, isPoint = geoJSONPoint(raw)
			}
			source, _ := p["Concesion_Fuente"].(string)
			switch {
			case isPolygon && domain.Intersects(shape, polygon):
				out.Related = append(out.Related, Related{ID: record.ID, Module: mr.Module,
					Relationship: "geometry", Evidence: "GeoJSON Polygon WGS84"})
			case !isPolygon && isPoint && domain.PointInPolygon(point, polygon):
				zero := 0.0
				out.Related = append(out.Related, Related{ID: record.ID, Module: mr.Module,
					Relationship: "geometry", Evidence: "Coordenadas explícitas WGS84", DistanceMeters: &zero})
			case code != "" && p["Concesion_Codigo"] == code && domain.Trim(source) != "":
				out.Related = append(out.Related, Related{ID: record.ID, Module: mr.Module,
					Relationship: "explicit-reference", Evidence: domain.SliceUTF16(source, 1000)})
			case !isPolygon && isPoint:
				out.Outside = append(out.Outside, Located{Module: mr.Module, ID: record.ID, At: point})
			}
			if !isPolygon && !isPoint {
				out.Unlocated = append(out.Unlocated, Unlocated{ID: record.ID, Module: mr.Module, Reason: unlocatedReason})
			}
		}
	}
	return out
}

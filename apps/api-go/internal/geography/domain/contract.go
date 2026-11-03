package domain

import (
	"math"
	"slices"
)

// ServiceIDs is GeographyServiceId: the fixed official INGEMMET services, in catalogue order.
var ServiceIDs = []string{
	"SERV_CATASTRO_MINERO",
	"SERV_MAPAS_GEOLOGICOS",
	"SERV_POTENCIALMINERO",
	"SERV_PELIGROS_GEOLOGICOS",
	"SERV_PASIVO_AMBIENTAL",
	"SERV_REINFO",
	"SERV_HIDROGEOLOGIA_PERU",
}

// DefaultServiceID is the service a query names when it names none.
const DefaultServiceID = "SERV_CATASTRO_MINERO"

// Query is a valid GeographyQuery: exactly one of BBox and Polygon is set.
type Query struct {
	ServiceID string
	LayerID   int
	BBox      *[4]float64
	Polygon   *Polygon
	// ConcessionCode is trimmed; empty when absent.
	ConcessionCode string
	// InfluenceMeters is 0 when absent.
	InfluenceMeters int
}

// The tolerance of the contract's own geometry (packages/contracts/src/geography.ts), stricter
// than the relation's boundaryEpsilon.
const contractEpsilon = 1e-12

func contractOnSegment(p, a, b Point) bool {
	return math.Abs(cross(a, b, p)) < contractEpsilon &&
		p[0] >= math.Min(a[0], b[0]) && p[0] <= math.Max(a[0], b[0]) &&
		p[1] >= math.Min(a[1], b[1]) && p[1] <= math.Max(a[1], b[1])
}

func meet(a, b, c, d Point) bool {
	return (cross(a, b, c)*cross(a, b, d) < 0 && cross(c, d, a)*cross(c, d, b) < 0) ||
		contractOnSegment(a, c, d) || contractOnSegment(b, c, d) ||
		contractOnSegment(c, a, b) || contractOnSegment(d, a, b)
}

func ringsMeet(a, b []Point) bool {
	for i := 1; i < len(a); i++ {
		for j := 1; j < len(b); j++ {
			if meet(a[i-1], a[i], b[j-1], b[j]) {
				return true
			}
		}
	}
	return false
}

// number is z.number(): a finite JSON number.
func number(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok && !math.IsNaN(f) && !math.IsInf(f, 0)
}

// integer is z.number().int() within [lo, hi].
func integer(v any, lo, hi int) (int, bool) {
	f, ok := number(v)
	if !ok || f != math.Trunc(f) || f < float64(lo) || f > float64(hi) {
		return 0, false
	}
	return int(f), true
}

func between(v any, lo, hi float64) (float64, bool) {
	f, ok := number(v)
	return f + 0, ok && f >= lo && f <= hi // + 0 turns -0 into 0, as JSON.stringify writes it
}

// strictKeys is .strict(): every key of m is allowed.
func strictKeys(m map[string]any, allowed ...string) bool {
	for k := range m {
		if !slices.Contains(allowed, k) {
			return false
		}
	}
	return true
}

func position(v any) (Point, bool) {
	tuple, ok := v.([]any)
	if !ok || len(tuple) != 2 {
		return Point{}, false
	}
	lon, okLon := between(tuple[0], -180, 180)
	lat, okLat := between(tuple[1], -90, 90)
	return Point{lon, lat}, okLon && okLat
}

// SignedArea is twice the shoelace area of a closed ring: positive counter-clockwise.
func SignedArea(ring []Point) float64 {
	area := 0.0
	for i := 1; i < len(ring); i++ {
		prev, c := ring[i-1], ring[i]
		area += prev[0]*c[1] - c[0]*prev[1]
	}
	return area
}

// ParsePolygon is GeographyPolygon.safeParse on a value decoded by DecodeJSON: a strict GeoJSON
// Polygon of 1-16 closed rings of 4-500 WGS84 positions, holes inside the exterior and apart
// from each other, no self-intersection and no ring without area.
func ParsePolygon(v any) (Polygon, bool) {
	m, ok := v.(map[string]any)
	if !ok || !strictKeys(m, "type", "coordinates") || m["type"] != "Polygon" {
		return Polygon{}, false
	}
	raw, ok := m["coordinates"].([]any)
	if !ok || len(raw) < 1 || len(raw) > 16 {
		return Polygon{}, false
	}
	rings := make([][]Point, len(raw))
	for i, r := range raw {
		points, ok := r.([]any)
		if !ok || len(points) < 4 || len(points) > 500 {
			return Polygon{}, false
		}
		rings[i] = make([]Point, len(points))
		for j, p := range points {
			if rings[i][j], ok = position(p); !ok {
				return Polygon{}, false
			}
		}
	}
	shell := rings[0]
	for index, hole := range rings[1:] {
		if !ringContains(hole[0], shell) || ringsMeet(shell, hole) {
			return Polygon{}, false // Hueco fuera del exterior
		}
		for _, other := range rings[1 : index+1] {
			if ringsMeet(other, hole) || ringContains(hole[0], other) || ringContains(other[0], hole) {
				return Polygon{}, false // Huecos superpuestos
			}
		}
	}
	for _, ring := range rings {
		for i := 1; i < len(ring); i++ {
			for j := i + 2; j < len(ring); j++ {
				if i == 1 && j == len(ring)-1 {
					continue
				}
				if meet(ring[i-1], ring[i], ring[j-1], ring[j]) {
					return Polygon{}, false // Anillo autointersectado
				}
			}
		}
		if first, last := ring[0], ring[len(ring)-1]; first != last {
			return Polygon{}, false // Anillo abierto
		}
		if math.Abs(SignedArea(ring)) < contractEpsilon {
			return Polygon{}, false // Anillo sin superficie
		}
	}
	return Polygon{Coordinates: rings}, true
}

// ParseQuery is GeographyQuery.safeParse on a value decoded by DecodeJSON.
func ParseQuery(v any) (Query, bool) {
	m, ok := v.(map[string]any)
	if !ok || !strictKeys(m, "serviceId", "layerId", "bbox", "polygon", "concessionCode", "influenceMeters") {
		return Query{}, false
	}
	q := Query{ServiceID: DefaultServiceID}
	if raw, present := m["serviceId"]; present {
		id, ok := raw.(string)
		if !ok || !slices.Contains(ServiceIDs, id) {
			return Query{}, false
		}
		q.ServiceID = id
	}
	if q.LayerID, ok = integer(m["layerId"], 0, 10_000); !ok {
		return Query{}, false
	}
	if raw, present := m["bbox"]; present {
		tuple, ok := raw.([]any)
		if !ok || len(tuple) != 4 {
			return Query{}, false
		}
		var b [4]float64
		for i, e := range tuple {
			limit := 180.0
			if i%2 == 1 {
				limit = 90
			}
			if b[i], ok = between(e, -limit, limit); !ok {
				return Query{}, false
			}
		}
		q.BBox = &b
	}
	if raw, present := m["polygon"]; present {
		p, ok := ParsePolygon(raw)
		if !ok {
			return Query{}, false
		}
		q.Polygon = &p
	}
	if raw, present := m["concessionCode"]; present {
		s, ok := raw.(string)
		if !ok {
			return Query{}, false
		}
		s = Trim(s)
		if n := UTF16Len(s); n < 1 || n > 100 {
			return Query{}, false
		}
		q.ConcessionCode = s
	}
	if raw, present := m["influenceMeters"]; present {
		if q.InfluenceMeters, ok = integer(raw, 0, 20_000); !ok {
			return Query{}, false
		}
	}
	// The refinements.
	if (q.BBox != nil) == (q.Polygon != nil) {
		return Query{}, false // Indique límites o polígono
	}
	b := q.bounds()
	if !(b[0] < b[2] && b[1] < b[3]) || b[2]-b[0] > 5 || b[3]-b[1] > 5 {
		return Query{}, false // Área inválida o demasiado extensa (máximo 5° por eje)
	}
	if (q.ConcessionCode != "" || q.InfluenceMeters != 0) && q.Polygon == nil {
		return Query{}, false // La relación requiere el polígono de la concesión
	}
	return q, true
}

// bounds is the bbox, or the polygon's extent.
func (q Query) bounds() [4]float64 {
	if q.BBox != nil {
		return *q.BBox
	}
	b := [4]float64{math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)}
	for _, r := range q.Polygon.Coordinates {
		for _, p := range r {
			b[0], b[1] = math.Min(b[0], p[0]), math.Min(b[1], p[1])
			b[2], b[3] = math.Max(b[2], p[0]), math.Max(b[3], p[1])
		}
	}
	return b
}

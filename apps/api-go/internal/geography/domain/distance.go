package domain

import "math"

// earthRadius is the mean Earth radius (IUGG), metres.
const earthRadius = 6_371_008.8

const radians = math.Pi / 180

// DistanceToPolygon is distanceToPolygon (domain/distance.ts): the shortest distance in metres
// from a WGS84 point to a polygon's boundary, 0 when the point is inside. Vertices are projected
// on a plane tangent at the point (equirectangular), within a few metres of the geodesic
// distance over the 20 km an area of influence spans; PostGIS replaces it where installed
// (docs/adr/0025).
func DistanceToPolygon(point Point, polygon Polygon) float64 {
	if PointInPolygon(point, polygon) {
		return 0
	}
	lon0, lat0 := point[0], point[1]
	scale := math.Cos(lat0 * radians)
	project := func(p Point) (float64, float64) {
		return (p[0] - lon0) * scale * radians * earthRadius, (p[1] - lat0) * radians * earthRadius
	}
	best := math.Inf(1)
	for _, r := range polygon.Coordinates {
		for i := 1; i < len(r); i++ {
			ax, ay := project(r[i-1])
			bx, by := project(r[i])
			dx, dy := bx-ax, by-ay
			length := dx*dx + dy*dy
			t := 0.0
			if length != 0 {
				t = math.Max(0, math.Min(1, -(ax*dx+ay*dy)/length))
			}
			best = math.Min(best, math.Hypot(ax+t*dx, ay+t*dy))
		}
	}
	return best
}

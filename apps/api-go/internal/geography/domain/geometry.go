// Package domain holds the geography rules that need no I/O: the planar geometry of
// apps/api/src/contexts/geography/domain/geometry.ts, the distance of domain/distance.ts, the
// GeographyQuery and GeographyPolygon contracts of packages/contracts/src/geography.ts, and the
// JavaScript semantics (numbers, trimming, JSON.parse) the TypeScript API answers with.
package domain

import "math"

// Point is a WGS84 [longitude, latitude] position.
type Point [2]float64

// Polygon is a GeoJSON Polygon: an exterior ring followed by its holes, each ring closed.
type Polygon struct {
	Coordinates [][]Point
}

// The tolerance geometry.ts uses for points on a boundary.
const boundaryEpsilon = 1e-10

func cross(a, b, c Point) float64 {
	return (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])
}

func onBoundarySegment(p, a, b Point) bool {
	return math.Abs(cross(a, b, p)) < boundaryEpsilon &&
		p[0] >= math.Min(a[0], b[0])-boundaryEpsilon &&
		p[0] <= math.Max(a[0], b[0])+boundaryEpsilon &&
		p[1] >= math.Min(a[1], b[1])-boundaryEpsilon &&
		p[1] <= math.Max(a[1], b[1])+boundaryEpsilon
}

// ringContains is the even-odd ray test of geometry.ts and the contracts.
func ringContains(p Point, r []Point) bool {
	inside := false
	for i, j := 0, len(r)-1; i < len(r); j, i = i, i+1 {
		a, b := r[i], r[j]
		if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0] {
			inside = !inside
		}
	}
	return inside
}

// PointInPolygon is pointInPolygon: true on any ring's boundary, else inside the exterior and
// outside every hole.
func PointInPolygon(p Point, polygon Polygon) bool {
	rings := polygon.Coordinates
	for _, r := range rings {
		for i := 1; i < len(r); i++ {
			if onBoundarySegment(p, r[i-1], r[i]) {
				return true
			}
		}
	}
	if len(rings) == 0 || !ringContains(p, rings[0]) {
		return false
	}
	for _, r := range rings[1:] {
		if ringContains(p, r) {
			return false
		}
	}
	return true
}

// Intersects is intersects: a vertex of one inside the other, or two edges properly crossing.
func Intersects(a, b Polygon) bool {
	for _, r := range a.Coordinates {
		for _, p := range r {
			if PointInPolygon(p, b) {
				return true
			}
		}
	}
	for _, r := range b.Coordinates {
		for _, p := range r {
			if PointInPolygon(p, a) {
				return true
			}
		}
	}
	for _, r := range a.Coordinates {
		for _, s := range b.Coordinates {
			for i := 1; i < len(r); i++ {
				for j := 1; j < len(s); j++ {
					p, q, u, v := r[i-1], r[i], s[j-1], s[j]
					if cross(p, q, u)*cross(p, q, v) < 0 && cross(u, v, p)*cross(u, v, q) < 0 {
						return true
					}
				}
			}
		}
	}
	return false
}

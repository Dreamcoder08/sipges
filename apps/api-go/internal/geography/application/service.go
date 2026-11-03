// Package application is the Go port of apps/api/src/contexts/geography/application: the
// read-only geography service that asks INGEMMET for official features and relates the
// project's own records to a concession polygon. It computes and persists nothing.
package application

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/domain"
)

// Layer is GeographyLayer.
type Layer struct {
	ServiceID    string         `json:"serviceId"`
	ID           domain.Number  `json:"id"`
	Name         string         `json:"name"`
	MinScale     *domain.Number `json:"minScale"`
	MaxScale     *domain.Number `json:"maxScale"`
	Capabilities string         `json:"capabilities"`
	Attribution  string         `json:"attribution"`
	ExportURL    string         `json:"exportUrl"`
	MetadataURL  string         `json:"metadataUrl"`
}

// ServiceStatus is one entry of GeographyCatalogue.services.
type ServiceStatus struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	CheckedAt string `json:"checkedAt"`
	Error     string `json:"error,omitempty"`
}

// Catalogue is GeographyCatalogue. Services and Layers are never nil.
type Catalogue struct {
	Status      string          `json:"status"`
	CheckedAt   string          `json:"checkedAt"`
	ServiceURL  string          `json:"serviceUrl"`
	Attribution string          `json:"attribution"`
	Services    []ServiceStatus `json:"services"`
	Layers      []Layer         `json:"layers"`
	Error       string          `json:"error,omitempty"`
}

// Feature is one official feature as INGEMMET sent it. A field INGEMMET left out stays out
// (nil); a JSON null is kept.
type Feature struct {
	Attributes json.RawMessage `json:"attributes,omitempty"`
	Geometry   json.RawMessage `json:"geometry,omitempty"`
}

// Official is what the gateway answers for a query.
type Official struct {
	Features  []Feature
	Truncated bool
	Source    string
}

// Related is one record related to the polygon.
type Related struct {
	ID           string `json:"id"`
	Module       string `json:"module"`
	Relationship string `json:"relationship"`
	Evidence     string `json:"evidence"`
	// DistanceMeters is metres from the record's coordinates to the polygon; 0 inside.
	DistanceMeters *float64 `json:"distanceMeters,omitempty"`
}

// Unlocated is a record without valid WGS84 geometry.
type Unlocated struct {
	ID     string `json:"id"`
	Module string `json:"module"`
	Reason string `json:"reason"`
}

// Influence is the area of influence that was requested and the engine that measured it.
type Influence struct {
	Meters int    `json:"meters"`
	Engine string `json:"engine"`
}

// Result is GeographyResult, in the TypeScript API's key order.
type Result struct {
	Features  []Feature   `json:"features"`
	Truncated bool        `json:"truncated"`
	Source    string      `json:"source"`
	Related   []Related   `json:"related"`
	Unlocated []Unlocated `json:"unlocated"`
	Influence *Influence  `json:"influence,omitempty"`
}

// Gateway is GeographyGateway: the official INGEMMET services.
type Gateway interface {
	// Catalogue never fails: unavailable services are reported inside it.
	Catalogue(ctx context.Context) Catalogue
	Query(ctx context.Context, q domain.Query) (Official, error)
}

// SpatialPoint is a located record, keyed by module and id.
type SpatialPoint struct {
	Key string
	At  domain.Point
}

// The engines a SpatialEngine names.
const (
	EnginePostGIS  = "postgis"
	EngineGeodesic = "geodesic"
)

// SpatialEngine measures distances from points to a polygon (docs/adr/0025): PostGIS, or the
// geodesic approximation. A point it could not measure is missing from meters.
type SpatialEngine interface {
	Distances(ctx context.Context, polygon domain.Polygon, points []SpatialPoint) (engine string, meters map[string]float64)
}

// Geodesic is geodesicSpatialEngine: the in-process approximation.
type Geodesic struct{}

// Distances implements SpatialEngine.
func (Geodesic) Distances(_ context.Context, polygon domain.Polygon, points []SpatialPoint) (string, map[string]float64) {
	meters := make(map[string]float64, len(points))
	for _, p := range points {
		meters[p.Key] = domain.DistanceToPolygon(p.At, polygon)
	}
	return EngineGeodesic, meters
}

// Record is one stored record of a module.
type Record struct {
	ID      string
	Payload map[string]any
}

// ModuleRecords are a module's records, newest first.
type ModuleRecords struct {
	Module  string
	Records []Record
}

// RecordReader reads the request's project records of modules, in that module order. The HTTP
// layer binds it to the request's tenant transaction.
type RecordReader func(ctx context.Context, modules []string) ([]ModuleRecords, error)

// RelatedModules are the modules whose records may be related to a polygon.
var RelatedModules = []string{"Eventos", "Demandas", "Actores", "Narrativas", "Reportes"} //nolint:misspell // module names

// Service is createGeographyService.
type Service struct {
	Gateway Gateway
	Spatial SpatialEngine
}

// Catalogue is the official catalogue.
func (s Service) Catalogue(ctx context.Context) Catalogue { return s.Gateway.Catalogue(ctx) }

// Query asks INGEMMET for the features of q and, when q has a polygon, relates the project's
// records to it: by geometry, by a documented concession reference, and within the area of
// influence, nearest first. Localities and names never place a record.
func (s Service) Query(ctx context.Context, q domain.Query, read RecordReader) (Result, error) {
	official, err := s.Gateway.Query(ctx, q)
	if err != nil {
		return Result{}, err
	}
	res := Result{Features: official.Features, Truncated: official.Truncated, Source: official.Source,
		Related: []Related{}, Unlocated: []Unlocated{}}
	if res.Features == nil {
		res.Features = []Feature{}
	}
	if q.Polygon == nil {
		return res, nil
	}
	recs, err := read(ctx, RelatedModules)
	if err != nil {
		return Result{}, err
	}
	rel := RelateRecords(recs, *q.Polygon, q.ConcessionCode)
	res.Related, res.Unlocated = rel.Related, rel.Unlocated
	if q.InfluenceMeters == 0 {
		return res, nil
	}
	points := make([]SpatialPoint, len(rel.Outside))
	for i, r := range rel.Outside {
		points[i] = SpatialPoint{Key: r.Module + "\x00" + r.ID, At: r.At}
	}
	engine, meters := s.Spatial.Distances(ctx, *q.Polygon, points)
	type near struct {
		Located
		distance float64
	}
	var nearby []near
	for i, r := range rel.Outside {
		d, ok := meters[points[i].Key]
		if ok && d <= float64(q.InfluenceMeters) { // NaN and unmeasured points never qualify
			nearby = append(nearby, near{r, d})
		}
	}
	sort.SliceStable(nearby, func(i, j int) bool { return nearby[i].distance < nearby[j].distance })
	label := "aproximación geodésica"
	if engine == EnginePostGIS {
		label = "PostGIS, elipsoide WGS84"
	}
	for _, r := range nearby {
		rounded := domain.Round(r.distance)
		res.Related = append(res.Related, Related{
			ID: r.ID, Module: r.Module, Relationship: "proximity",
			Evidence:       "Coordenadas explícitas a " + domain.FormatNumber(rounded) + " m del límite oficial (" + label + ")",
			DistanceMeters: &rounded,
		})
	}
	res.Influence = &Influence{Meters: q.InfluenceMeters, Engine: engine}
	return res, nil
}

package infrastructure

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
)

// recheck is how long an answer about the extension is trusted before asking again.
const recheck = 10 * time.Minute

// PostGIS is createPostgisSpatialEngine (infrastructure/spatial-engine.ts): distances on the
// WGS84 spheroid (`geography`), computed from the request alone. No table is read or written,
// so tenancy and markings stay with the records reader. The extension is never created here;
// until an operator installs it (docs/adr/0025), and whenever a query fails, the geodesic
// approximation answers instead.
type PostGIS struct {
	db  database.Querier
	now func() time.Time
	log *slog.Logger

	mu    sync.Mutex
	known *extensionCheck
}

type extensionCheck struct {
	available bool
	at        time.Time
}

// NewPostGIS returns the engine on db (nil: always the approximation); now is the clock (nil
// means time.Now) and log may be nil.
func NewPostGIS(db database.Querier, now func() time.Time, log *slog.Logger) *PostGIS {
	if now == nil {
		now = time.Now
	}
	return &PostGIS{db: db, now: now, log: log}
}

func (e *PostGIS) remember(available bool) {
	e.mu.Lock()
	e.known = &extensionCheck{available: available, at: e.now()}
	e.mu.Unlock()
}

func (e *PostGIS) available(ctx context.Context) bool {
	if e.db == nil {
		return false
	}
	e.mu.Lock()
	known := e.known
	e.mu.Unlock()
	if known != nil && e.now().Sub(known.at) < recheck {
		return known.available
	}
	var present bool
	err := e.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS present`).Scan(&present)
	e.remember(err == nil && present)
	return err == nil && present
}

type geoJSONPolygon struct {
	Type        string               `json:"type"`
	Coordinates [][][2]domain.Number `json:"coordinates"`
}

type pointRow struct {
	Key string        `json:"key"`
	Lon domain.Number `json:"lon"`
	Lat domain.Number `json:"lat"`
}

// Distances implements application.SpatialEngine.
func (e *PostGIS) Distances(ctx context.Context, polygon domain.Polygon, points []application.SpatialPoint) (string, map[string]float64) {
	if len(points) == 0 || !e.available(ctx) {
		return application.Geodesic{}.Distances(ctx, polygon, points)
	}
	meters, err := e.query(ctx, polygon, points)
	if err != nil {
		if e.log != nil {
			e.log.LogAttrs(ctx, slog.LevelWarn, "postgis_distance_failed", slog.String("error", err.Error()))
		}
		e.remember(false)
		return application.Geodesic{}.Distances(ctx, polygon, points)
	}
	return application.EnginePostGIS, meters
}

func (e *PostGIS) query(ctx context.Context, polygon domain.Polygon, points []application.SpatialPoint) (map[string]float64, error) {
	shape := geoJSONPolygon{Type: "Polygon", Coordinates: make([][][2]domain.Number, len(polygon.Coordinates))}
	for i, r := range polygon.Coordinates {
		shape.Coordinates[i] = make([][2]domain.Number, len(r))
		for j, p := range r {
			shape.Coordinates[i][j] = [2]domain.Number{domain.Number(p[0]), domain.Number(p[1])}
		}
	}
	rows := make([]pointRow, len(points))
	for i, p := range points {
		rows[i] = pointRow{Key: p.Key, Lon: domain.Number(p.At[0]), Lat: domain.Number(p.At[1])}
	}
	shapeJSON, err := json.Marshal(shape)
	if err != nil {
		return nil, err
	}
	pointsJSON, err := json.Marshal(rows)
	if err != nil {
		return nil, err
	}
	result, err := e.db.Query(ctx, `SELECT p.key,
	        ST_Distance(
	          ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography,
	          ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326)::geography
	        ) AS meters
	   FROM jsonb_to_recordset($2::jsonb) AS p(key text, lon float8, lat float8)`, string(shapeJSON), string(pointsJSON))
	if err != nil {
		return nil, err
	}
	defer result.Close()
	meters := make(map[string]float64, len(points))
	for result.Next() {
		var key string
		var distance *float64
		if err := result.Scan(&key, &distance); err != nil {
			return nil, err
		}
		meters[key] = 0 // Number(null) is 0 in the TypeScript engine
		if distance != nil {
			meters[key] = *distance
		}
	}
	return meters, result.Err()
}

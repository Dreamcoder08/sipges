package infrastructure

import (
	"context"
	"errors"
	"math"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// Ported from apps/api/test/geography/influence.test.ts (spatial engine parts).

// square is a synthetic 0.01° square near Sechura.
var square = domain.Polygon{Coordinates: [][]domain.Point{{
	{-80.9, -5.6}, {-80.89, -5.6}, {-80.89, -5.59}, {-80.9, -5.59}, {-80.9, -5.6},
}}}

type row struct {
	present bool
	err     error
}

func (r row) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*dest[0].(*bool) = r.present
	return nil
}

// fakeDB answers the extension check and fails every distance query.
type fakeDB struct {
	present bool
	checks  int
	queries int
	failRow error
}

func (f *fakeDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	f.queries++
	return nil, errors.New("function st_distance does not exist")
}

func (f *fakeDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	if strings.Contains(sql, "pg_extension") {
		f.checks++
	}
	return row{f.present, f.failRow}
}

func (f *fakeDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}

var north = []application.SpatialPoint{{Key: "a", At: domain.Point{-80.895, -5.581}}}

func TestPostGISFallsBackWithoutTheExtensionAndCachesTheCheck(t *testing.T) {
	db := &fakeDB{}
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	e := NewPostGIS(db, func() time.Time { return now }, nil)
	engine, meters := e.Distances(t.Context(), square, north)
	if engine != application.EngineGeodesic || math.Abs(meters["a"]-1000) > 10 {
		t.Fatalf("%s %v", engine, meters)
	}
	e.Distances(t.Context(), square, north)
	if db.checks != 1 || db.queries != 0 {
		t.Fatalf("checks %d, queries %d: the extension check is cached", db.checks, db.queries)
	}
	now = now.Add(10 * time.Minute)
	e.Distances(t.Context(), square, north)
	if db.checks != 2 {
		t.Fatalf("checks %d: the answer is rechecked after ten minutes", db.checks)
	}
}

func TestPostGISNeedsNoCheckWithoutPoints(t *testing.T) {
	db := &fakeDB{present: true}
	engine, meters := NewPostGIS(db, nil, nil).Distances(t.Context(), square, nil)
	if engine != application.EngineGeodesic || len(meters) != 0 || db.checks != 0 {
		t.Fatalf("%s %v, %d checks", engine, meters, db.checks)
	}
}

func TestPostGISFailuresFallBackAndMarkTheExtensionUnavailable(t *testing.T) {
	db := &fakeDB{present: true}
	e := NewPostGIS(db, nil, nil)
	if engine, _ := e.Distances(t.Context(), square, north); engine != application.EngineGeodesic || db.queries != 1 {
		t.Fatalf("%s, %d queries", engine, db.queries)
	}
	if e.Distances(t.Context(), square, north); db.queries != 1 || db.checks != 1 {
		t.Fatalf("after a failure: %d queries, %d checks", db.queries, db.checks)
	}
	failing := &fakeDB{failRow: errors.New("down")}
	if engine, _ := NewPostGIS(failing, nil, nil).Distances(t.Context(), square, north); engine != application.EngineGeodesic {
		t.Fatalf("a failed check: %s", engine)
	}
	if engine, _ := NewPostGIS(nil, nil, nil).Distances(t.Context(), square, north); engine != application.EngineGeodesic {
		t.Fatalf("no database: %s", engine)
	}
}

// Real PostGIS, opt-in like the TypeScript test: a throwaway database gets the extension, and
// the test skips where the server does not ship PostGIS.
func TestPostGISAgreesWithTheGeodesicApproximation(t *testing.T) {
	adminURL := os.Getenv(dbtest.EnvAdminURL)
	if adminURL == "" {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	ctx := t.Context()
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(context.Background()) }()
	var shipped bool
	if err := admin.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis')`).Scan(&shipped); err != nil || !shipped {
		t.Skip("PostGIS is not available on this server")
	}
	s, err := dbtest.NewScratch(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Drop(context.Background()) })
	conn, err := pgx.Connect(ctx, s.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	if _, err := conn.Exec(ctx, `CREATE EXTENSION IF NOT EXISTS postgis`); err != nil {
		t.Skip("cannot create the PostGIS extension: " + err.Error())
	}
	points := []application.SpatialPoint{
		{Key: "inside", At: domain.Point{-80.895, -5.595}},
		{Key: "north", At: domain.Point{-80.895, -5.581}},
		{Key: "corner", At: domain.Point{-80.87, -5.57}},
		{Key: "far", At: domain.Point{-80.8, -5.5}},
	}
	engine, gis := NewPostGIS(conn, nil, nil).Distances(ctx, square, points)
	_, approx := application.Geodesic{}.Distances(ctx, square, points)
	if engine != application.EnginePostGIS || gis["inside"] != 0 {
		t.Fatalf("%s %v", engine, gis)
	}
	for _, p := range points[1:] {
		if a, b := gis[p.Key], approx[p.Key]; math.Abs(a-b)/a >= 0.01 {
			t.Errorf("%s: PostGIS %v, geodesic %v", p.Key, a, b)
		}
	}
}

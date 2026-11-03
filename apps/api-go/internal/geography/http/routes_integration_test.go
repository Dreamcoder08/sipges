//nolint:misspell // Spanish bodies are compared byte for byte.
package http_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/domain"
	geographyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/http"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	identity "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancyapp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/application"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/infrastructure"
)

// Ported from apps/api/test/geography/http.test.ts and the request-boundary checks of
// apps/api/test/system/request-boundaries.test.ts, against a migrated synthetic PostgreSQL.
// INGEMMET is never called: requests that reach the gateway use a fake one. Every account,
// project, token and record here is synthetic.

var scratch *dbtest.Scratch

func TestMain(m *testing.M) { os.Exit(run(m)) }

func run(m *testing.M) int {
	adminURL := os.Getenv(dbtest.EnvAdminURL)
	if adminURL == "" {
		return m.Run() // integration tests skip themselves
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	s, err := dbtest.NewScratch(ctx, adminURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "scratch database:", err)
		return 1
	}
	defer func() {
		if err := s.Drop(context.Background()); err != nil {
			fmt.Fprintln(os.Stderr, "drop scratch database:", err)
		}
	}()
	if err := seed(ctx, s.URL); err != nil {
		fmt.Fprintln(os.Stderr, "seed scratch database:", err)
		return 1
	}
	scratch = s
	return m.Run()
}

var t0 = time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)

var tokens = map[string]string{}

func seed(ctx context.Context, dsn string) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(ctx) }()
	// The concession is the unit square; ACME/NORTE and SIPGES/PRJ-SECHURA both have records in it.
	if _, err := conn.Exec(ctx, `
		INSERT INTO tenants (company_id, project_id, label) VALUES
		  ('SIPGES','PRJ-SECHURA','Sechura'), ('ACME','NORTE','Norte') ON CONFLICT DO NOTHING;
		INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
		  ('multi',   'Multi Admin',  'x', 'admin',    true, true),
		  ('solo',    'Solo Analyst', 'x', 'analista', true, true),
		  ('reader',  'Read Only',    'x', 'consulta', true, true),
		  ('nogrant', 'No Grants',    'x', 'analista', true, true);
		INSERT INTO grants (username, tenant_id) VALUES
		  ('multi','SIPGES/PRJ-SECHURA'), ('multi','ACME/NORTE'),
		  ('solo','SIPGES/PRJ-SECHURA'), ('reader','ACME/NORTE');
		INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking) VALUES
		  ('ACME/NORTE','Eventos','EV-IN','{"Longitud":0.5,"Latitud":0.5}', now(), now() - interval '1 hour', 'interno'),
		  ('ACME/NORTE','Eventos','EV-NAME','{"Territorio":"Norte"}', now(), now(), 'interno'),
		  ('ACME/NORTE','Eventos','EV-SECRET','{"Longitud":0.6,"Latitud":0.6}', now(), now(), 'restringido'),
		  ('ACME/NORTE','Demandas','DE-POLY','{"geometry":{"type":"Polygon","coordinates":[[[0.9,0.9],[2,0.9],[2,2],[0.9,2],[0.9,0.9]]]}}', now(), now(), 'interno'),
		  ('ACME/NORTE','Actores','AC-REF','{"Concesion_Codigo":"C1","Concesion_Fuente":"Resolución sintética <1>"}', now(), now(), 'interno'),
		  ('ACME/NORTE','Reportes','RE-NEAR','{"Longitud":"1.005","Latitud":"0.5"}', now(), now(), 'interno'),
		  ('ACME/NORTE','Reportes','RE-FAR','{"Longitud":1.5,"Latitud":0.5}', now(), now(), 'interno'),
		  ('ACME/NORTE','Otros','OT-IN','{"Longitud":0.5,"Latitud":0.5}', now(), now(), 'interno'),
		  ('SIPGES/PRJ-SECHURA','Eventos','SOUTH-IN','{"Longitud":0.4,"Latitud":0.4}', now(), now(), 'interno'),
		  ('SIPGES/PRJ-SECHURA','Actores','SOUTH-REF','{"Concesion_Codigo":"C1","Concesion_Fuente":"Otra"}', now(), now(), 'interno');`); err != nil {
		return err
	}
	batch := &pgx.Batch{}
	for _, user := range []string{"multi", "solo", "reader", "nogrant"} {
		var b [32]byte
		_, _ = rand.Read(b[:])
		tokens[user] = hex.EncodeToString(b[:])
		batch.Queue(`INSERT INTO sessions (token_hash, username, expires_at) VALUES ($1, $2, $3)`,
			identity.HashToken(tokens[user]), user, t0.Add(8*time.Hour))
	}
	return conn.SendBatch(ctx, batch).Close()
}

func now() time.Time { return t0 }

// fakeGateway stands in for INGEMMET.
type fakeGateway struct {
	mu      sync.Mutex
	queries int
	fail    bool
}

func (g *fakeGateway) Catalogue(context.Context) application.Catalogue {
	return application.Catalogue{Status: "verified", CheckedAt: "2026-11-03T12:00:00.000Z", ServiceURL: "fake",
		Attribution: "INGEMMET – GEOCATMIN", Services: []application.ServiceStatus{}, Layers: []application.Layer{}}
}

func (g *fakeGateway) Query(context.Context, domain.Query) (application.Official, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.queries++
	if g.fail {
		return application.Official{}, errors.New("timeout")
	}
	return application.Official{Features: []application.Feature{{Attributes: []byte(`{"CODIGOU":"a&b"}`)}}, Source: "fake/0"}, nil
}

func pool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if scratch == nil {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	p, err := pgxpool.New(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	return p
}

// composed is app.NewHandler's chain with a fake gateway, which app.Options cannot carry.
func composed(t *testing.T, gateway application.Gateway) *httptest.Server {
	t.Helper()
	p := pool(t)
	logger := slog.New(slog.DiscardHandler)
	h := httpx.NewHandler(httpx.Options{
		Logger: logger,
		Ready:  database.Ping(p),
		Auth: []httpx.Middleware{
			identityhttp.Session(identityhttp.SessionOptions{Sessions: identity.Sessions{DB: p, Now: now}, Logger: logger}),
			geographyhttp.RequestLimit(),
			tenancyhttp.Middleware(tenancyapp.NewGrantCache(tenancy.Grants{DB: p}.List, now), logger),
			identityhttp.RoleGate(),
		},
		Routes: func(mux *http.ServeMux) {
			geographyhttp.Register(mux, geographyhttp.Deps{Pool: p, Logger: logger, Now: now, Gateway: gateway})
		},
	})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

// production is app.NewHandler itself, for every answer given before the gateway is reached.
func production(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(app.NewHandler(pool(t), app.Options{Logger: slog.New(slog.DiscardHandler), Now: now}))
	t.Cleanup(srv.Close)
	return srv
}

type req struct {
	method, path, user, body, scope string
	sameOrigin                      bool
	stream                          bool   // no Content-Length
	contentType                     string // default application/json when there is a body
}

func do(t *testing.T, srv *httptest.Server, q req) (int, string) {
	t.Helper()
	method := q.method
	if method == "" {
		method = http.MethodGet
	}
	var body io.Reader = strings.NewReader(q.body)
	if q.stream {
		body = io.MultiReader(strings.NewReader(q.body))
	}
	r, err := http.NewRequestWithContext(t.Context(), method, srv.URL+q.path, body)
	if err != nil {
		t.Fatal(err)
	}
	if q.user != "" {
		r.Header.Set("Cookie", "sipges_session="+tokens[q.user])
	}
	if q.sameOrigin {
		r.Header.Set("Origin", srv.URL)
	}
	if q.scope != "" {
		r.Header.Set("X-SIPGES-Scope", q.scope)
	}
	if q.contentType != "" {
		r.Header.Set("Content-Type", q.contentType)
	} else if q.body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	res, err := srv.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func expect(t *testing.T, status int, body string, wantStatus int, want string) {
	t.Helper()
	if status != wantStatus || body != want {
		t.Fatalf("got %d %s\nwant %d %s", status, body, wantStatus, want)
	}
}

const (
	signIn      = `{"detail":"Inicie sesión para acceder a SIPGES"}`
	badJSON     = `{"detail":"JSON inválido"}`
	badArea     = `{"detail":"Área o capa inválida. Use WGS84 y un máximo de 5° por eje."}`
	unreachable = `{"detail":"No fue posible consultar INGEMMET. Intente nuevamente o consulte el visor oficial."}`
	square      = `{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}`
	queryPath   = "/system/geography/query"
)

func TestQueryRelatesOnlyTheResolvedProjectsRecords(t *testing.T) {
	gw := &fakeGateway{}
	srv := composed(t, gw)
	body := `{"layerId":0,"polygon":` + square + `,"concessionCode":"C1","influenceMeters":1000}`
	status, got := do(t, srv, req{method: "POST", path: queryPath, user: "multi", scope: "ACME/NORTE", sameOrigin: true, body: body})
	expect(t, status, got, http.StatusOK, `{"features":[{"attributes":{"CODIGOU":"a&b"}}],"truncated":false,"source":"fake/0","related":[`+
		`{"id":"EV-SECRET","module":"Eventos","relationship":"geometry","evidence":"Coordenadas explícitas WGS84","distanceMeters":0},`+
		`{"id":"EV-IN","module":"Eventos","relationship":"geometry","evidence":"Coordenadas explícitas WGS84","distanceMeters":0},`+
		`{"id":"DE-POLY","module":"Demandas","relationship":"geometry","evidence":"GeoJSON Polygon WGS84"},`+
		`{"id":"AC-REF","module":"Actores","relationship":"explicit-reference","evidence":"Resolución sintética <1>"},`+
		`{"id":"RE-NEAR","module":"Reportes","relationship":"proximity","evidence":"Coordenadas explícitas a 556 m del límite oficial (aproximación geodésica)","distanceMeters":556}],`+
		`"unlocated":[{"id":"EV-NAME","module":"Eventos","reason":"Sin geometría WGS84 válida; Territorio no se geocodifica"},`+
		`{"id":"AC-REF","module":"Actores","reason":"Sin geometría WGS84 válida; Territorio no se geocodifica"}],"influence":{"meters":1000,"engine":"geodesic"}}`)

	// The other project, by header and by cookie: only its own rows.
	southOnly := `{"features":[{"attributes":{"CODIGOU":"a&b"}}],"truncated":false,"source":"fake/0","related":[` +
		`{"id":"SOUTH-IN","module":"Eventos","relationship":"geometry","evidence":"Coordenadas explícitas WGS84","distanceMeters":0},` +
		`{"id":"SOUTH-REF","module":"Actores","relationship":"explicit-reference","evidence":"Otra"}],` +
		`"unlocated":[{"id":"SOUTH-REF","module":"Actores","reason":"Sin geometría WGS84 válida; Territorio no se geocodifica"}]}`
	southBody := `{"layerId":0,"polygon":` + square + `,"concessionCode":"C1"}`
	status, got = do(t, srv, req{method: "POST", path: queryPath, user: "multi", scope: "SIPGES/PRJ-SECHURA", sameOrigin: true, body: southBody})
	expect(t, status, got, http.StatusOK, southOnly)
	status, got = do(t, srv, req{method: "POST", path: queryPath, user: "solo", sameOrigin: true, body: southBody})
	expect(t, status, got, http.StatusOK, southOnly)

	// A read-only account may query (a read-only POST) and never sees restricted records.
	status, got = do(t, srv, req{method: "POST", path: queryPath, user: "reader", sameOrigin: true, body: `{"layerId":0,"polygon":` + square + `}`})
	if status != http.StatusOK || strings.Contains(got, "EV-SECRET") || !strings.Contains(got, `"id":"EV-IN"`) {
		t.Fatalf("reader: %d %s", status, got)
	}
}

func TestQueryWithABoundingBoxRelatesNothing(t *testing.T) {
	srv := composed(t, &fakeGateway{})
	status, got := do(t, srv, req{method: "POST", path: queryPath, user: "solo", sameOrigin: true, body: `{"layerId":0,"bbox":[0,0,1,1]}`})
	expect(t, status, got, http.StatusOK, `{"features":[{"attributes":{"CODIGOU":"a&b"}}],"truncated":false,"source":"fake/0","related":[],"unlocated":[]}`)
}

func TestCatalogueAndUpstreamFailures(t *testing.T) {
	gw := &fakeGateway{fail: true}
	srv := composed(t, gw)
	status, got := do(t, srv, req{path: "/system/geography/catalogue", user: "reader"})
	expect(t, status, got, http.StatusOK, `{"status":"verified","checkedAt":"2026-11-03T12:00:00.000Z","serviceUrl":"fake","attribution":"INGEMMET – GEOCATMIN","services":[],"layers":[]}`)
	status, got = do(t, srv, req{method: "POST", path: queryPath, user: "solo", sameOrigin: true, body: `{"layerId":0,"bbox":[0,0,1,1]}`})
	expect(t, status, got, http.StatusBadGateway, unreachable)
}

func TestInvalidQueriesNeverReachTheGateway(t *testing.T) {
	gw := &fakeGateway{}
	srv := composed(t, gw)
	for name, c := range map[string]struct {
		body, want, contentType string
	}{
		"malformed JSON":  {`{"layerId":`, badJSON, ""},
		"empty body":      {``, badJSON, ""},
		"trailing data":   {`{"layerId":0,"bbox":[0,0,1,1]} x`, badJSON, ""},
		"supplied URL":    {`{"layerId":0,"bbox":[0,0,1,1],"url":"https://evil.test"}`, badArea, ""},
		"wider than 5°":   {`{"layerId":0,"bbox":[0,0,6,1]}`, badArea, ""},
		"unknown service": {`{"serviceId":"SERV_OTRO","layerId":0,"bbox":[0,0,1,1]}`, badArea, ""},
		"not an object":   {`[1]`, badArea, ""},
		// Sent as text: the tenancy middleware refuses JSON bodies nested beyond encoding/json.
		"nested very deeply": {strings.Repeat("[", 20_000) + strings.Repeat("]", 20_000), badArea, "text/plain"},
		"form body":          {`a=b`, badJSON, "application/x-www-form-urlencoded"},
	} {
		t.Run(name, func(t *testing.T) {
			status, got := do(t, srv, req{method: "POST", path: queryPath, user: "solo", sameOrigin: true, body: c.body, contentType: c.contentType})
			expect(t, status, got, http.StatusUnprocessableEntity, c.want)
		})
	}
	gw.mu.Lock()
	defer gw.mu.Unlock()
	if gw.queries != 0 {
		t.Fatalf("the gateway was asked %d times", gw.queries)
	}
}

func TestTheComposedAPIGatesGeographyRoutes(t *testing.T) {
	srv := production(t)
	big := `{"layerId":0,"bbox":[0,0,1,1],"pad":"` + strings.Repeat("x", 100_000) + `"}`
	for name, c := range map[string]struct {
		q          req
		status     int
		body       string
		bodyPrefix string
	}{
		"catalogue without a session": {q: req{path: "/system/geography/catalogue"}, status: 401, body: signIn},
		"query without a session":     {q: req{method: "POST", path: queryPath, sameOrigin: true, body: `{}`}, status: 401, body: signIn},
		"query without Origin":        {q: req{method: "POST", path: queryPath, user: "solo", body: `{}`}, status: 403, body: `{"detail":"Origen de solicitud no permitido"}`},
		"a project without a grant": {q: req{method: "POST", path: queryPath, user: "solo", scope: "ACME/NORTE", sameOrigin: true, body: `{"layerId":0,"bbox":[0,0,1,1]}`},
			status: 403, bodyPrefix: `{"detail":"Seleccione un proyecto autorizado`},
		"catalogue of a project without a grant": {q: req{path: "/system/geography/catalogue", user: "solo", scope: "ACME/NORTE"},
			status: 403, bodyPrefix: `{"detail":"Seleccione un proyecto autorizado`},
		// 413 comes before the project scope: a user without grants still gets it.
		"oversized, declared":   {q: req{method: "POST", path: queryPath, user: "nogrant", sameOrigin: true, body: big}, status: 413, body: tooLarge},
		"oversized, streamed":   {q: req{method: "POST", path: queryPath, user: "nogrant", sameOrigin: true, body: big, stream: true}, status: 413, body: tooLarge},
		"oversized, no session": {q: req{method: "POST", path: queryPath, sameOrigin: true, body: big}, status: 401, body: signIn},
		"invalid JSON":          {q: req{method: "POST", path: queryPath, user: "solo", sameOrigin: true, body: `nope`}, status: 422, body: badJSON},
		"invalid area":          {q: req{method: "POST", path: queryPath, user: "solo", sameOrigin: true, body: `{"layerId":0,"bbox":[0,0,100,80]}`}, status: 422, body: badArea},
		"GET on the query path": {q: req{path: queryPath, user: "solo"}, status: 404, body: `{"detail":"Not Found"}`},
	} {
		t.Run(name, func(t *testing.T) {
			status, got := do(t, srv, c.q)
			if c.status != http.StatusRequestEntityTooLarge && c.status != http.StatusUnprocessableEntity {
				got = strings.TrimSuffix(got, "\n") // httpx.WriteError's newline: the identity and tenancy gates
			}
			if status != c.status || (c.bodyPrefix == "" && got != c.body) || !strings.HasPrefix(got, c.bodyPrefix) {
				t.Fatalf("got %d %s, want %d %s%s", status, got, c.status, c.body, c.bodyPrefix)
			}
		})
	}
}

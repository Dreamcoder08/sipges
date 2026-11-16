package infrastructure

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/domain"
)

// Ported from apps/api/test/geography/geography.test.ts (gateway parts): every answer comes from
// a local TLS server standing in for INGEMMET, never the real service. Layers are synthetic.

const servicesPath = "/arcgis/rest/services/"

type fakeIngemmet struct {
	srv   *httptest.Server
	mu    sync.Mutex
	urls  []string
	calls atomic.Int32
}

// newFake serves handler over TLS and returns a gateway pointed at it, with a settable clock.
func newFake(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) (*fakeIngemmet, *Gateway, *time.Time) {
	t.Helper()
	f := &fakeIngemmet{}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		f.mu.Lock()
		f.urls = append(f.urls, r.URL.String())
		f.mu.Unlock()
		if r.Header.Get("Accept") != "application/json" {
			http.Error(w, "accept", http.StatusBadRequest)
			return
		}
		handler(w, r)
	}))
	t.Cleanup(f.srv.Close)
	now := time.Date(2026, 11, 3, 12, 0, 0, 123_000_000, time.UTC)
	g := NewGateway(func() time.Time { return now })
	g.origin = f.srv.URL + servicesPath
	g.client = f.srv.Client()
	return f, g, &now
}

func writeJSON(w http.ResponseWriter, body string) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(body))
}

// service is the service id of a request path.
func service(r *http.Request) string {
	rest := strings.TrimPrefix(r.URL.Path, servicesPath)
	id, _, _ := strings.Cut(rest, "/")
	return id
}

const layersBody = `{"layers":[
	{"id":3,"name":"Oficial sintético","type":"Feature Layer","minScale":1000,"maxScale":0},
	{"id":4,"name":"Con capacidades","type":"Feature Layer","capabilities":"Query","copyrightText":"Propio"},
	{"id":5,"name":"Grupo","type":"Group Layer"},
	{"id":1.5,"name":"Fraccional","type":"Feature Layer"},
	{"id":6,"name":7,"type":"Feature Layer"},
	null, 8]}`

func TestCatalogueDiscoversLayersOnTheFixedServices(t *testing.T) {
	f, g, _ := newFake(t, func(w http.ResponseWriter, r *http.Request) {
		if service(r) == "SERV_REINFO" {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/MapServer/layers") {
			writeJSON(w, layersBody)
			return
		}
		writeJSON(w, `{"capabilities":"Map,Query","copyrightText":""}`)
	})
	cat := g.Catalogue(t.Context())
	if cat.Status != "verified" || cat.CheckedAt != "2026-11-03T12:00:00.123Z" || cat.ServiceURL != g.origin ||
		cat.Attribution != "INGEMMET – GEOCATMIN" || cat.Error != "" {
		t.Fatalf("catalogue %+v", cat)
	}
	if len(cat.Services) != len(domain.ServiceIDs) || len(cat.Layers) != 2*(len(domain.ServiceIDs)-1) {
		t.Fatalf("%d services, %d layers", len(cat.Services), len(cat.Layers))
	}
	for i, s := range cat.Services {
		if s.ID != domain.ServiceIDs[i] {
			t.Fatalf("service order %v", cat.Services)
		}
		if s.ID == "SERV_REINFO" && (s.Status != "unavailable" || s.Error != "No se pudo verificar el servicio oficial. Revise INGEMMET; no se inventan capas ni escalas.") {
			t.Fatalf("unavailable service %+v", s)
		}
	}
	b, _ := json.Marshal(cat.Layers[:2])
	base := g.origin + "SERV_CATASTRO_MINERO/MapServer"
	want := `[{"serviceId":"SERV_CATASTRO_MINERO","id":3,"name":"Oficial sintético","minScale":1000,"maxScale":0,"capabilities":"Map,Query","attribution":"INGEMMET","exportUrl":"` + base + `/export","metadataUrl":"` + base + `/3"},` +
		`{"serviceId":"SERV_CATASTRO_MINERO","id":4,"name":"Con capacidades","minScale":null,"maxScale":null,"capabilities":"Query","attribution":"Propio","exportUrl":"` + base + `/export","metadataUrl":"` + base + `/4"}]`
	if string(b) != want {
		t.Fatalf("layers\n%s\nwant\n%s", b, want)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, u := range f.urls {
		if !strings.HasPrefix(u, servicesPath+"SERV_") || !strings.Contains(u, "/MapServer") || !strings.HasSuffix(u, "f=json") {
			t.Fatalf("unexpected destination %s", u)
		}
	}
}

func TestCatalogueIsCachedFiveMinutesOrThirtySecondsWhenEmpty(t *testing.T) {
	var down atomic.Bool
	f, g, now := newFake(t, func(w http.ResponseWriter, _ *http.Request) {
		if down.Load() {
			writeJSON(w, `{"error":{"code":500}}`)
			return
		}
		writeJSON(w, `{"layers":[{"id":0,"name":"L","type":"Feature Layer"}],"capabilities":"Query"}`)
	})
	g.Catalogue(t.Context())
	first := f.calls.Load()
	*now = now.Add(5*time.Minute - time.Millisecond)
	g.Catalogue(t.Context())
	if f.calls.Load() != first {
		t.Fatal("asked again within five minutes")
	}
	down.Store(true)
	*now = now.Add(time.Millisecond)
	cat := g.Catalogue(t.Context())
	if f.calls.Load() == first || cat.Status != "unavailable" || cat.Error != "No fue posible verificar el catálogo oficial." || len(cat.Layers) != 0 {
		t.Fatalf("expired catalogue not refreshed: %+v", cat)
	}
	b, _ := json.Marshal(cat)
	if !strings.Contains(string(b), `"layers":[]`) || !strings.Contains(string(b), `"error":"No fue posible`) {
		t.Fatalf("empty catalogue JSON %s", b)
	}
	second := f.calls.Load()
	*now = now.Add(30*time.Second - time.Millisecond)
	g.Catalogue(t.Context())
	if f.calls.Load() != second {
		t.Fatal("an empty catalogue was not cached for 30 s")
	}
	*now = now.Add(time.Millisecond)
	g.Catalogue(t.Context())
	if f.calls.Load() == second {
		t.Fatal("an empty catalogue was cached beyond 30 s")
	}
}

func TestAnOlderLookupNeverReplacesANewerCatalogue(t *testing.T) {
	release := make(chan struct{})
	var first atomic.Bool
	_, g, _ := newFake(t, func(w http.ResponseWriter, _ *http.Request) {
		if first.CompareAndSwap(false, true) {
			<-release // the earlier caller's lookup hangs
			http.Error(w, "offline", http.StatusBadGateway)
			return
		}
		writeJSON(w, `{"layers":[{"id":7,"name":"Sintética","type":"Feature Layer"}],"capabilities":"Map"}`)
	})
	older := make(chan application.Catalogue)
	go func() { older <- g.Catalogue(context.Background()) }()
	for !first.Load() {
		time.Sleep(time.Millisecond)
	}
	newer := g.Catalogue(t.Context()) // must not wait on the hung lookup
	if newer.Status != "verified" || len(newer.Services) != len(domain.ServiceIDs) {
		t.Fatalf("newer %+v", newer)
	}
	close(release)
	old := <-older
	unavailable := false
	for _, s := range old.Services {
		unavailable = unavailable || s.Status == "unavailable"
	}
	if !unavailable {
		t.Fatalf("older lookup %+v", old.Services)
	}
	again := g.Catalogue(t.Context())
	a, _ := json.Marshal(again)
	n, _ := json.Marshal(newer)
	if string(a) != string(n) {
		t.Fatalf("cache replaced by the older lookup:\n%s\n%s", a, n)
	}
}

func TestGatewayRefusesRedirectsOversizedBodiesAndSlowAnswers(t *testing.T) {
	for name, handler := range map[string]func(w http.ResponseWriter, r *http.Request){
		"redirect": func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("moved") == "" {
				http.Redirect(w, r, r.URL.Path+"?f=json&moved=1", http.StatusFound)
				return
			}
			writeJSON(w, `{"layers":[{"id":0,"name":"L","type":"Feature Layer"}]}`)
		},
		"declared length": func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, `{"layers":[{"id":0,"name":"L","type":"Feature Layer"}],"pad":"`+strings.Repeat("x", 200)+`"}`)
		},
		"streamed": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"layers":[{"id":0,"name":"L","type":"Feature Layer"}],"pad":"`))
			w.(http.Flusher).Flush() // no Content-Length: chunked
			_, _ = w.Write([]byte(strings.Repeat("x", 200) + `"}`))
		},
		"slow": func(w http.ResponseWriter, r *http.Request) {
			select {
			case <-time.After(2 * time.Second):
			case <-r.Context().Done():
			}
			writeJSON(w, `{"layers":[]}`)
		},
		"not JSON":   func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, `<html>`) },
		"null":       func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, `null`) },
		"error":      func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, `{"error":{"code":400},"layers":[]}`) },
		"no layers":  func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, `{"layers":{}}`) },
		"HTTP error": func(w http.ResponseWriter, _ *http.Request) { http.Error(w, "{}", http.StatusInternalServerError) },
	} {
		t.Run(name, func(t *testing.T) {
			_, g, _ := newFake(t, handler)
			g.maxBytes = 150
			g.timeout = 100 * time.Millisecond
			cat := g.Catalogue(t.Context())
			if cat.Status != "unavailable" || len(cat.Layers) != 0 {
				t.Fatalf("catalogue %+v", cat)
			}
		})
	}
}

func TestQueryNormalizesRingsAndBoundsTheAnswer(t *testing.T) {
	var queried atomic.Pointer[url.URL]
	var features atomic.Value
	features.Store(`{"features":[{"attributes":{"CODIGOU":"synthetic","2":1.0,"AREA":1e400,"1":-0,"NOTA":"a<b&c"},"geometry":{"x":1}},` +
		`{"geometry":null},7,{"attributes":null}],"exceededTransferLimit":true}`)
	_, g, _ := newFake(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/query") {
			if r.URL.Query().Get("returnIdsOnly") == "true" {
				// The area step: answer one id per prepared feature (at least one, so the
				// malformed answers below still reach the feature step).
				queried.Store(r.URL)
				var shape struct{ Features []json.RawMessage }
				_ = json.Unmarshal([]byte(features.Load().(string)), &shape)
				writeJSON(w, `{"objectIdFieldName":"OBJECTID","objectIds":[`+idList(max(1, len(shape.Features)))+`]}`)
				return
			}
			writeJSON(w, features.Load().(string))
			return
		}
		writeJSON(w, `{"layers":[{"id":0,"type":"Feature Layer","name":"Derechos","capabilities":"Query"},`+
			`{"id":2,"type":"Feature Layer","name":"Solo mapa","capabilities":"Map"}],"capabilities":"Map,Query"}`)
	})
	parse := func(body string) domain.Query {
		v, err := domain.DecodeJSON([]byte(body))
		if err != nil {
			t.Fatal(err)
		}
		q, ok := domain.ParseQuery(v)
		if !ok {
			t.Fatalf("invalid %s", body)
		}
		return q
	}
	// A counter-clockwise exterior and a clockwise hole, both reversed for ArcGIS.
	res, err := g.Query(t.Context(), parse(`{"layerId":0,"polygon":{"type":"Polygon","coordinates":[`+
		`[[0,0],[4,0],[4,4],[0,4],[0,0]],[[1,1],[1,2],[2,2],[2,1],[1,1]]]}}`))
	if err != nil {
		t.Fatal(err)
	}
	u := queried.Load()
	wantQuery := "f=json&where=1%3D1&returnIdsOnly=true&inSR=4326&spatialRel=esriSpatialRelIntersects" +
		"&geometryType=esriGeometryPolygon&geometry=" +
		"%7B%22rings%22%3A%5B%5B%5B0%2C0%5D%2C%5B0%2C4%5D%2C%5B4%2C4%5D%2C%5B4%2C0%5D%2C%5B0%2C0%5D%5D%2C" +
		"%5B%5B1%2C1%5D%2C%5B2%2C1%5D%2C%5B2%2C2%5D%2C%5B1%2C2%5D%2C%5B1%2C1%5D%5D%5D%2C%22spatialReference%22%3A%7B%22wkid%22%3A4326%7D%7D"
	if u.Path != servicesPath+"SERV_CATASTRO_MINERO/MapServer/0/query" || u.RawQuery != wantQuery {
		t.Fatalf("queried %s?%s", u.Path, u.RawQuery)
	}
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(res.Features)
	if want := `[{"attributes":{"1":0,"2":1,"CODIGOU":"synthetic","AREA":null,"NOTA":"a<b&c"},"geometry":{"x":1}},` +
		`{"geometry":null},{},{"attributes":null}]` + "\n"; buf.String() != want {
		t.Fatalf("features %s", buf.String())
	}
	if !res.Truncated || res.Source != g.origin+"SERV_CATASTRO_MINERO/MapServer/0" {
		t.Fatalf("result %+v", res)
	}

	// An envelope, and 201 features cut to 200 and reported as truncated.
	many := make([]string, 201)
	for i := range many {
		many[i] = `{"attributes":{}}`
	}
	features.Store(`{"features":[` + strings.Join(many, ",") + `]}`)
	res, err = g.Query(t.Context(), parse(`{"layerId":0,"bbox":[-80.5,-6,-80,-5.5]}`))
	if err != nil || len(res.Features) != 200 || !res.Truncated {
		t.Fatalf("%d features, truncated %v, %v", len(res.Features), res.Truncated, err)
	}
	if got := queried.Load().Query().Get("geometry"); got != `{"xmin":-80.5,"ymin":-6,"xmax":-80,"ymax":-5.5,"spatialReference":{"wkid":4326}}` ||
		queried.Load().Query().Get("geometryType") != "esriGeometryEnvelope" {
		t.Fatalf("envelope %s", got)
	}
	features.Store(`{"features":[{"attributes":{}}]}`)
	if res, _ = g.Query(t.Context(), parse(`{"layerId":0,"bbox":[0,0,1,1]}`)); res.Truncated {
		t.Fatal("one feature reported as truncated")
	}

	for name, body := range map[string]string{
		"no features":  `{"features":{}}`,
		"null feature": `{"features":[null]}`,
		"error":        `{"error":{"code":400},"features":[]}`,
	} {
		features.Store(body)
		if _, err := g.Query(t.Context(), parse(`{"layerId":0,"bbox":[0,0,1,1]}`)); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
	for _, layer := range []string{"1", "2"} { // unknown, and without the Query capability
		if _, err := g.Query(t.Context(), parse(`{"layerId":`+layer+`,"bbox":[0,0,1,1]}`)); err == nil || !strings.Contains(err.Error(), "Capa no verificable") {
			t.Errorf("layer %s: %v", layer, err)
		}
	}
}

func TestTheProductionGatewayUsesTheFixedOrigin(t *testing.T) {
	g := NewGateway(nil)
	if g.origin != Origin || Origin != "https://geocatmin.ingemmet.gob.pe/arcgis/rest/services/" ||
		g.timeout != 8*time.Second || g.maxBytes != 2_000_000 || g.client.CheckRedirect == nil {
		t.Fatalf("gateway %+v", g)
	}
}

// GEOCATMIN's cadastre (ArcGIS 10.91) rejects resultRecordCount: "Pagination is not supported"
// (live check 2026-11-15). The gateway asks for the ids first and then the first 200 by id.
func TestQueryWorksOnAServerWithoutPagination(t *testing.T) {
	var ids atomic.Value
	ids.Store(`{"objectIdFieldName":"OBJECTID","objectIds":[` + idList(250) + `]}`)
	var byIDRequests, idRequests atomic.Int32
	var lastIDs atomic.Value
	_, g, _ := newFake(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/query") {
			writeJSON(w, `{"layers":[{"id":0,"type":"Feature Layer","name":"Derechos","capabilities":"Query"}],"capabilities":"Map,Query"}`)
			return
		}
		q := r.URL.Query()
		switch {
		case q.Has("resultRecordCount") || q.Has("resultOffset"):
			writeJSON(w, `{"error":{"code":400,"message":"Pagination is not supported.","details":[]}}`)
		case q.Get("returnIdsOnly") == "true":
			idRequests.Add(1)
			writeJSON(w, ids.Load().(string))
		case q.Has("objectIds"):
			byIDRequests.Add(1)
			lastIDs.Store(q.Get("objectIds"))
			parts := strings.Split(q.Get("objectIds"), ",")
			features := make([]string, len(parts))
			for i, id := range parts {
				features[i] = `{"attributes":{"OBJECTID":` + id + `}}`
			}
			writeJSON(w, `{"features":[`+strings.Join(features, ",")+`]}`)
		default:
			writeJSON(w, `{"error":{"code":400,"message":"unexpected query"}}`)
		}
	})
	q := domain.Query{ServiceID: "SERV_CATASTRO_MINERO", LayerID: 0, BBox: &[4]float64{-80.85, -5.85, -80.75, -5.75}}

	res, err := g.Query(t.Context(), q)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(res.Features) != 200 || !res.Truncated {
		t.Fatalf("%d features, truncated %v; want the first 200 of 250, truncated", len(res.Features), res.Truncated)
	}
	if got := lastIDs.Load().(string); got != idList(200) {
		t.Fatalf("asked for ids %q, want the first 200 in the server's order", got)
	}

	ids.Store(`{"objectIdFieldName":"OBJECTID","objectIds":[` + idList(3) + `]}`)
	if res, err = g.Query(t.Context(), q); err != nil || len(res.Features) != 3 || res.Truncated {
		t.Fatalf("3 ids: %d features, truncated %v, %v", len(res.Features), res.Truncated, err)
	}

	before := byIDRequests.Load()
	ids.Store(`{"objectIdFieldName":"OBJECTID","objectIds":null}`) // ArcGIS's answer when nothing intersects
	if res, err = g.Query(t.Context(), q); err != nil || len(res.Features) != 0 || res.Truncated {
		t.Fatalf("no ids: %d features, truncated %v, %v", len(res.Features), res.Truncated, err)
	}
	if byIDRequests.Load() != before {
		t.Fatal("asked for features although no id intersects")
	}

	for name, body := range map[string]string{
		"error":         `{"error":{"code":500}}`,
		"ids not array": `{"objectIds":{}}`,
		"fractional id": `{"objectIds":[1.5]}`,
		"negative id":   `{"objectIds":[-1]}`,
	} {
		ids.Store(body)
		if _, err := g.Query(t.Context(), q); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

// idList is "1,2,…,n".
func idList(n int) string {
	parts := make([]string, 0, n)
	for i := 1; i <= n; i++ {
		parts = append(parts, strconv.Itoa(i))
	}
	return strings.Join(parts, ",")
}

package infrastructure

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/geography/domain"
)

// Origin is the only destination the gateway reaches: INGEMMET's GEOCATMIN services. It is
// fixed in code, never configured.
const Origin = "https://geocatmin.ingemmet.gob.pe/arcgis/rest/services/"

const (
	defaultTimeout  = 8 * time.Second
	defaultMaxBytes = 2_000_000
	// catalogueTTL is how long a catalogue with layers is trusted; emptyTTL one without.
	catalogueTTL = 5 * time.Minute
	emptyTTL     = 30 * time.Second
	// maxFeatures is the most features asked for and returned.
	maxFeatures = 200
)

const unavailableService = "No se pudo verificar el servicio oficial. Revise INGEMMET; no se inventan capas ni escalas."

var errRedirect = errors.New("geography: INGEMMET redirects are refused")

// Gateway is createIngemmetGateway (infrastructure/index.ts): fixed official destinations,
// TLS validation on, redirects rejected, an 8 s timeout and a 2 MB limit per answer.
type Gateway struct {
	// origin and client are replaced only by this package's tests.
	origin   string
	client   *http.Client
	now      func() time.Time
	timeout  time.Duration
	maxBytes int64

	mu      sync.Mutex
	cached  *cachedCatalogue
	lookups int
}

type cachedCatalogue struct {
	lookup  int
	expires time.Time
	data    application.Catalogue
}

// NewGateway returns the INGEMMET gateway; now is the clock (nil means time.Now).
func NewGateway(now func() time.Time) *Gateway {
	if now == nil {
		now = time.Now
	}
	return &Gateway{origin: Origin, client: &http.Client{CheckRedirect: refuseRedirect}, now: now,
		timeout: defaultTimeout, maxBytes: defaultMaxBytes}
}

func refuseRedirect(*http.Request, []*http.Request) error { return errRedirect }

func (g *Gateway) serviceURL(id string) string { return g.origin + id + "/MapServer" }

// fetch is index.ts json(): one GET of an official JSON answer. A null answer, one that is not
// JSON or one carrying a truthy "error" fails; any other non-object reads as an empty object.
func (g *Gateway) fetch(ctx context.Context, url string) (*object, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), g.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	client := *g.client
	client.CheckRedirect = refuseRedirect // whatever client is used, redirects stay refused
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("INGEMMET HTTP %d", res.StatusCode)
	}
	tooLarge := errors.New("INGEMMET excede el límite de respuesta")
	if res.ContentLength > g.maxBytes {
		return nil, tooLarge
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, g.maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > g.maxBytes {
		return nil, tooLarge
	}
	v, err := parseOrdered(body)
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, errors.New("respuesta oficial nula") // null['error'] throws
	}
	data, ok := v.(*object)
	if !ok {
		data = &object{vals: map[string]any{}}
	}
	if domain.Truthy(data.get("error")) {
		return nil, errors.New("INGEMMET rechazó la consulta")
	}
	return data, nil
}

func isoMillis(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// serviceLayers verifies one service and lists its query-ready feature layers.
func (g *Gateway) serviceLayers(ctx context.Context, id string) ([]application.Layer, error) {
	base := g.serviceURL(id)
	data, err := g.fetch(ctx, base+"/layers?f=json")
	if err != nil {
		return nil, err
	}
	root, err := g.fetch(ctx, base+"?f=json")
	if err != nil {
		return nil, err
	}
	list, ok := data.get("layers").([]any)
	if !ok {
		return nil, errors.New("catálogo oficial inválido")
	}
	layers := []application.Layer{}
	for _, raw := range list {
		l, ok := raw.(*object)
		if !ok {
			continue
		}
		layerID, isNumber := l.get("id").(float64)
		name, isName := l.get("name").(string)
		if l.get("type") != "Feature Layer" || !isNumber || math.IsInf(layerID, 0) || layerID != math.Trunc(layerID) || !isName {
			continue
		}
		capabilities, ok := l.get("capabilities").(string)
		if !ok {
			capabilities = ""
			if c := root.get("capabilities"); c != nil {
				capabilities = jsString(c)
			}
		}
		attribution := "INGEMMET"
		if c := l.get("copyrightText"); domain.Truthy(c) {
			attribution = jsString(c)
		} else if c := root.get("copyrightText"); domain.Truthy(c) {
			attribution = jsString(c)
		}
		layers = append(layers, application.Layer{
			ServiceID: id, ID: domain.Number(layerID), Name: name,
			MinScale: scale(l.get("minScale")), MaxScale: scale(l.get("maxScale")),
			Capabilities: capabilities, Attribution: attribution,
			ExportURL: base + "/export", MetadataURL: base + "/" + domain.FormatNumber(layerID),
		})
	}
	return layers, nil
}

func scale(v any) *domain.Number {
	f, ok := v.(float64)
	if !ok {
		return nil
	}
	n := domain.Number(f)
	return &n
}

// Catalogue implements application.Gateway. Only a settled catalogue is shared: concurrent cold
// callers repeat the lookup rather than wait on one another, and a slower lookup that started
// earlier never replaces a newer answer.
func (g *Gateway) Catalogue(ctx context.Context) application.Catalogue {
	g.mu.Lock()
	if g.cached != nil && g.cached.expires.After(g.now()) {
		data := g.cached.data
		g.mu.Unlock()
		return data
	}
	g.lookups++
	lookup := g.lookups
	g.mu.Unlock()

	checkedAt := isoMillis(g.now())
	type answer struct {
		layers []application.Layer
		err    error
	}
	answers := make([]answer, len(domain.ServiceIDs))
	for i := 0; i < len(domain.ServiceIDs); i += 2 { // two services at a time
		var wg sync.WaitGroup
		for j := i; j < min(i+2, len(domain.ServiceIDs)); j++ {
			wg.Go(func() {
				layers, err := g.serviceLayers(ctx, domain.ServiceIDs[j])
				answers[j] = answer{layers, err}
			})
		}
		wg.Wait()
	}
	data := application.Catalogue{Status: "unavailable", CheckedAt: checkedAt, ServiceURL: g.origin,
		Attribution: "INGEMMET – GEOCATMIN", Services: []application.ServiceStatus{}, Layers: []application.Layer{}}
	for i, a := range answers {
		id := domain.ServiceIDs[i]
		if a.err != nil {
			data.Services = append(data.Services, application.ServiceStatus{ID: id, Status: "unavailable",
				CheckedAt: checkedAt, Error: unavailableService})
			continue
		}
		data.Layers = append(data.Layers, a.layers...)
		data.Services = append(data.Services, application.ServiceStatus{ID: id, Status: "verified", CheckedAt: checkedAt})
		data.Status = "verified"
	}
	ttl := catalogueTTL
	if len(data.Layers) == 0 {
		data.Error = "No fue posible verificar el catálogo oficial."
		ttl = emptyTTL
	}
	g.mu.Lock()
	if g.cached == nil || g.cached.lookup < lookup {
		g.cached = &cachedCatalogue{lookup: lookup, expires: g.now().Add(ttl), data: data}
	}
	g.mu.Unlock()
	return data
}

// formEncode is URLSearchParams serialization (application/x-www-form-urlencoded) of ordered
// pairs: only ALPHA, DIGIT and *-._ stay as they are, and a space is '+'.
func formEncode(pairs [][2]string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i, p := range pairs {
		if i > 0 {
			b.WriteByte('&')
		}
		for k, s := range p {
			if k == 1 {
				b.WriteByte('=')
			}
			for _, c := range []byte(s) {
				switch {
				case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '*', c == '-', c == '.', c == '_':
					b.WriteByte(c)
				case c == ' ':
					b.WriteByte('+')
				default:
					b.WriteByte('%')
					b.WriteByte(hex[c>>4])
					b.WriteByte(hex[c&0xf])
				}
			}
		}
	}
	return b.String()
}

func num(f float64) string { return domain.FormatNumber(f) }

// geometry is the JSON.stringify'd ArcGIS geometry of q: polygon rings oriented as ArcGIS wants
// them (exterior clockwise, holes counter-clockwise), or the envelope.
func geometry(q domain.Query) string {
	var b strings.Builder
	if q.Polygon == nil {
		bb := *q.BBox
		fmt.Fprintf(&b, `{"xmin":%s,"ymin":%s,"xmax":%s,"ymax":%s,"spatialReference":{"wkid":4326}}`,
			num(bb[0]), num(bb[1]), num(bb[2]), num(bb[3]))
		return b.String()
	}
	b.WriteString(`{"rings":[`)
	for index, ring := range q.Polygon.Coordinates {
		area := domain.SignedArea(ring)
		points := ring
		if (index == 0 && area > 0) || (index > 0 && area < 0) {
			points = make([]domain.Point, len(ring))
			for i, p := range ring {
				points[len(ring)-1-i] = p
			}
		}
		if index > 0 {
			b.WriteByte(',')
		}
		b.WriteByte('[')
		for i, p := range points {
			if i > 0 {
				b.WriteByte(',')
			}
			fmt.Fprintf(&b, "[%s,%s]", num(p[0]), num(p[1]))
		}
		b.WriteByte(']')
	}
	b.WriteString(`],"spatialReference":{"wkid":4326}}`)
	return b.String()
}

// Query implements application.Gateway: the official features of a verified, queryable layer
// within the area, at most 200.
func (g *Gateway) Query(ctx context.Context, q domain.Query) (application.Official, error) {
	cat := g.Catalogue(ctx)
	var layer *application.Layer
	for i, l := range cat.Layers {
		if l.ServiceID == q.ServiceID && float64(l.ID) == float64(q.LayerID) && strings.Contains(l.Capabilities, "Query") {
			layer = &cat.Layers[i]
			break
		}
	}
	if layer == nil {
		return application.Official{}, errors.New("Capa no verificable o sin capacidad de consulta") //nolint:staticcheck // the TypeScript message
	}
	geometryType := "esriGeometryEnvelope"
	if q.Polygon != nil {
		geometryType = "esriGeometryPolygon"
	}
	params := formEncode([][2]string{
		{"f", "json"}, {"where", "1=1"}, {"outFields", "*"}, {"returnGeometry", "true"},
		{"outSR", "4326"}, {"inSR", "4326"}, {"spatialRel", "esriSpatialRelIntersects"},
		{"resultRecordCount", strconv.Itoa(maxFeatures)}, {"geometryType", geometryType},
		{"geometry", geometry(q)},
	})
	data, err := g.fetch(ctx, g.serviceURL(q.ServiceID)+"/"+strconv.Itoa(q.LayerID)+"/query?"+params)
	if err != nil {
		return application.Official{}, err
	}
	list, ok := data.get("features").([]any)
	if !ok {
		return application.Official{}, errors.New("respuesta geográfica oficial inválida")
	}
	features := make([]application.Feature, 0, min(len(list), maxFeatures))
	for _, raw := range list[:min(len(list), maxFeatures)] {
		if raw == nil {
			return application.Official{}, errors.New("respuesta geográfica oficial inválida") // null['attributes'] throws
		}
		var f application.Feature
		if o, ok := raw.(*object); ok {
			if v, present := o.vals["attributes"]; present {
				f.Attributes = stringified(v)
			}
			if v, present := o.vals["geometry"]; present {
				f.Geometry = stringified(v)
			}
		}
		features = append(features, f)
	}
	return application.Official{
		Features:  features,
		Truncated: data.get("exceededTransferLimit") == true || len(list) >= maxFeatures,
		Source:    layer.MetadataURL,
	}, nil
}

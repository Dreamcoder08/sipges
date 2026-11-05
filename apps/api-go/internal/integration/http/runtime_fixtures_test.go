//nolint:misspell // Spanish module names, fields and messages, verbatim from the TypeScript API.
package http_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	identity "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	integrationhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	recordsapp "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// The runtime routes against the answers testdata/routes.mjs recorded from the TypeScript routes
// over the same services, with the same in-memory stores, fake gateways and fixed clock: same
// status, same body (key order included), same WWW-Authenticate and Idempotent-Replayed headers,
// and the same narratives handed to the importer.

type fixtureCase struct {
	Method          string            `json:"method"`
	Path            string            `json:"path"`
	Headers         map[string]string `json:"headers"`
	Body            *string           `json:"body"`
	Status          int               `json:"status"`
	Response        string            `json:"response"`
	WWWAuthenticate *string           `json:"www_authenticate"`
	Replayed        *string           `json:"replayed"`
	Captured        []struct {
		ID      string `json:"id"`
		Payload string `json:"payload"`
	} `json:"captured"`
}

var fixtureNow = time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)

const secret = "SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"

// fakeKeys is the generator's `keys`.
type fakeKeys struct{}

func (fakeKeys) Authenticate(_ context.Context, header string, present bool) (*domain.Principal, error) {
	token, ok := domain.BearerToken(header, present)
	if !ok {
		return nil, nil
	}
	principals := map[string]domain.Principal{
		"mscli_aaaaaaaaaaaa_" + secret: {Access: "write", TenantID: "SIPGES/PRJ-SECHURA"},
		"mscli_bbbbbbbbbbbb_" + secret: {Access: "read", TenantID: "SIPGES/PRJ-SECHURA"},
		"mscli_cccccccccccc_" + secret: {Access: "write", TenantID: "PARITY"},
	}
	p, found := principals[token]
	if !found {
		return nil, nil
	}
	p.KeyID, p.Name, p.Clearance = 7, "sintetica", "full"
	return &p, nil
}

func (fakeKeys) Revoke(_ context.Context, _ string, id int) (bool, error) { return id == 12, nil }

// fakeIngest is the generator's `ingest`: it echoes what it received.
type fakeIngest struct{}

func (fakeIngest) Run(_ context.Context, req application.IngestRequest) (application.Outcome, error) {
	o := records.NewObject()
	o.Set("slug", req.Slug)
	o.Set("project", req.ProjectID)
	if req.Key == "" {
		o.Set("key", nil)
	} else {
		o.Set("key", req.Key)
	}
	o.Set("body", req.Body)
	status := 201
	if req.Slug == "parcial" {
		status = 207
	}
	return application.Outcome{Response: application.Response{Status: status, Body: records.Stringify(o)}, Replayed: req.Key == "repetida"}, nil
}

// fakeFeeds is the generator's `feedStore`.
type fakeFeeds struct{}

func stored(id int, f application.FeedWrite) *domain.MediaFeed {
	return &domain.MediaFeed{ID: id, Name: f.Name, URL: f.URL, Keywords: f.Keywords, Territory: f.Territory,
		AuthorizationNote: f.AuthorizationNote, Enabled: f.Enabled, UpdatedBy: f.Actor, UpdatedAt: f.At}
}

func (fakeFeeds) Create(_ context.Context, _ string, f application.FeedWrite) (*domain.MediaFeed, string, error) {
	switch {
	case f.Name == "LLENO":
		return nil, "limit", nil
	case f.URL == "https://duplicada.example/rss":
		return nil, "duplicate", nil
	}
	return stored(41, f), "", nil
}

func (fakeFeeds) Update(_ context.Context, _ string, id int, f application.FeedWrite) (*domain.MediaFeed, bool, error) {
	switch {
	case id == 404:
		return nil, false, nil
	case f.URL == "https://duplicada.example/rss":
		return nil, true, nil
	}
	return stored(id, f), false, nil
}

func (fakeFeeds) Remove(_ context.Context, _ string, id int, _ time.Time) (bool, error) {
	return id != 404, nil
}

func (fakeFeeds) ClaimDue(context.Context, string, time.Time, int) ([]domain.MediaFeed, error) {
	return nil, nil
}

func (fakeFeeds) Finish(context.Context, string, int, time.Time, int, int, string) error { return nil }

// fakeFeedGateway is the generator's `gateway`.
type fakeFeedGateway struct{ xml string }

func (g fakeFeedGateway) Read(_ context.Context, url string) ([]domain.FeedItem, error) {
	if i := strings.Index(url, "error-"); i >= 0 {
		code := url[i+6:]
		code = code[:strings.IndexFunc(code, func(r rune) bool { return (r < 'a' || r > 'z') && r != '_' })]
		if code == "other" {
			return nil, errors.New("boom")
		}
		return nil, &domain.FeedError{Code: "feed_" + code}
	}
	return domain.ParseFeed(g.xml), nil
}

// fakeOfficial is the generator's `sourceGateway`.
type fakeOfficial struct{}

var posts = []domain.OfficialPost{
	{ID: 101, URL: "https://www.defensoria.gob.pe/sintetica-uno/", Title: "Publicación sintética «uno»",
		Excerpt: "Extracto sintético con \"comillas\" y \u2028 separador", PublishedAt: "2026-10-01T10:00:00.000Z"},
	{ID: 2147483647, URL: "https://www.defensoria.gob.pe/sintetica-dos/?a=1&b=%C3%B1", Title: "Dos",
		Excerpt: "", PublishedAt: "2026-10-02T00:00:00.000Z"},
}

func (fakeOfficial) Preview(_ context.Context, query string) ([]domain.OfficialPost, error) {
	switch query {
	case "falla":
		return nil, &domain.SourceError{Code: domain.SourceUnavailable}
	case "vacia":
		return []domain.OfficialPost{}, nil
	}
	return posts, nil
}

func (fakeOfficial) Get(_ context.Context, id int) (domain.OfficialPost, error) {
	for _, p := range posts {
		if p.ID == id {
			return p, nil
		}
	}
	return domain.OfficialPost{}, &domain.SourceError{Code: domain.SourceNotFound}
}

// fakeSettings is the generator's `settings`.
type fakeSettings struct{}

func (fakeSettings) Get(context.Context, string) (domain.SourceState, error) {
	return domain.SourceState{}, nil
}

func (fakeSettings) Save(_ context.Context, _ string, in domain.SourceConfig, username string, at time.Time) (domain.SourceState, error) {
	return domain.SourceState{Enabled: in.Enabled, Query: in.Query, Territory: in.Territory,
		AuthorizationNote: in.AuthorizationNote, Revision: 4, UpdatedBy: username, UpdatedAt: &at}, nil
}

func (fakeSettings) ClaimPoll(context.Context, string, int, time.Time) (bool, error) {
	return false, nil
}

func (fakeSettings) FinishPoll(context.Context, string, time.Time, int, int, string) error {
	return nil
}

func (fakeSettings) ActiveTenants(context.Context) ([]string, error) { return nil, nil }

// fakeNarratives makes the real Importer behave as the generator's `importer`: "repetida" is
// already there from the same source, "colision" from another one.
type fakeNarratives struct{ captured *[]capturedNarrative }

type capturedNarrative struct{ id, payload string }

func territory(p *records.Object) string {
	v, _ := p.Get("Territorio")
	s, _ := v.(string)
	return s
}

func (n fakeNarratives) Create(_ context.Context, _, _ string, candidates func(yield func(string) bool), payloadFor func(string) *records.Object, _ recordsapp.AuditNote, _ time.Time) (string, error) {
	id := ""
	candidates(func(c string) bool { id = c; return false })
	payload := payloadFor(id)
	*n.captured = append(*n.captured, capturedNarrative{id, string(records.Stringify(payload))})
	if t := territory(payload); t == "repetida" || t == "colision" {
		return "", nil
	}
	return id, nil
}

func (n fakeNarratives) Get(_ context.Context, _, _, id string) (*recordsapp.StoredRecord, error) {
	last := (*n.captured)[len(*n.captured)-1]
	payload, _ := records.ParseObject([]byte(last.payload))
	if territory(payload) == "colision" {
		payload.Set("Fuente_Huella_SHA256", "otra")
	}
	return &recordsapp.StoredRecord{ID: id, Payload: payload}, nil
}

func fixtureHandler(t *testing.T, captured *[]capturedNarrative) http.Handler {
	t.Helper()
	xml, err := os.ReadFile("../testdata/feed.xml")
	if err != nil {
		t.Fatal(err)
	}
	clock := application.Clock(func() time.Time { return fixtureNow })
	importer := application.Importer{Store: fakeNarratives{captured}, Clock: clock}
	runtime := integrationhttp.Runtime{
		Keys:    fakeKeys{},
		Ingest:  fakeIngest{},
		Media:   application.Media{Feeds: fakeFeeds{}, Gateway: fakeFeedGateway{string(xml)}, Importer: importer, Clock: clock},
		Sources: application.Sources{Gateway: fakeOfficial{}, Settings: fakeSettings{}, Importer: importer, Clock: clock},
	}
	signedIn := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := identityhttp.WithPrincipal(r.Context(), &identity.Principal{Username: "parity-admin"})
			ctx = tenancyhttp.WithScope(ctx, tenancy.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-SECHURA"})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
	return httpx.NewHandler(httpx.Options{
		Auth:   []httpx.Middleware{signedIn},
		Routes: func(mux *http.ServeMux) { integrationhttp.RegisterRuntime(mux, runtime) },
	})
}

// expand is the generator's `expand`: `@repeat:<n>` is {"a": "x" repeated n times}.
func expand(body string) string {
	if n, ok := strings.CutPrefix(body, "@repeat:"); ok {
		count := 0
		for _, c := range n {
			count = count*10 + int(c-'0')
		}
		return `{"a":"` + strings.Repeat("x", count) + `"}`
	}
	return body
}

// canonical rewrites a JSON text as records.Stringify writes it, keeping key order.
func canonical(t *testing.T, text string) string {
	t.Helper()
	v, err := records.ParseBody([]byte(text))
	if err != nil {
		return "unparsable: " + text
	}
	return string(records.Stringify(v))
}

func TestRuntimeRoutesMatchTypeScript(t *testing.T) {
	data, err := os.ReadFile("../testdata/routes.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []fixtureCase `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	var captured []capturedNarrative
	h := fixtureHandler(t, &captured)
	for i, c := range fixture.Cases {
		captured = captured[:0]
		var req *http.Request
		if c.Body != nil {
			req = httptest.NewRequest(c.Method, c.Path, strings.NewReader(expand(*c.Body)))
		} else {
			req = httptest.NewRequest(c.Method, c.Path, nil)
		}
		for k, v := range c.Headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		name := c.Method + " " + c.Path
		if c.Body != nil && len(*c.Body) < 120 {
			name += " " + *c.Body
		}
		if rec.Code != c.Status {
			t.Errorf("case %d %s: status %d, TypeScript %d (%s)", i, name, rec.Code, c.Status, rec.Body.String())
			continue
		}
		if got, want := canonical(t, rec.Body.String()), canonical(t, c.Response); got != want {
			t.Errorf("case %d %s:\n got  %s\n want %s", i, name, got, want)
		}
		if got := rec.Header().Get("WWW-Authenticate"); c.WWWAuthenticate != nil && got != *c.WWWAuthenticate || c.WWWAuthenticate == nil && got != "" {
			t.Errorf("case %d %s: WWW-Authenticate %q", i, name, got)
		}
		if got := rec.Header().Get("Idempotent-Replayed"); c.Replayed != nil && got != *c.Replayed || c.Replayed == nil && got != "" {
			t.Errorf("case %d %s: Idempotent-Replayed %q", i, name, got)
		}
		if len(captured) != len(c.Captured) {
			t.Errorf("case %d %s: %d narratives, TypeScript %d", i, name, len(captured), len(c.Captured))
			continue
		}
		for j, want := range c.Captured {
			if captured[j].id != want.ID || captured[j].payload != want.Payload {
				t.Errorf("case %d %s: narrative\n got  %s %s\n want %s %s", i, name, captured[j].id, captured[j].payload, want.ID, want.Payload)
			}
		}
	}
}

//nolint:misspell // Spanish module names, fields and messages, verbatim from the TypeScript API.
package infrastructure

import (
	"context"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The two gateways against the answers testdata/domain.mjs recorded from rss-feed-gateway.ts and
// official-source.ts over a fake fetch: a local TLS server sends the same status, headers and
// bytes, and the result (items, posts or the failure code) must be the same. Then the egress
// limits Node enforces through fetch options: deadlines, redirects and the connection address.

type served struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Throws  bool              `json:"throws"`
	Large   int               `json:"large"`
	Long    int               `json:"longTitle"`
	Hex     *string           `json:"hex"`
}

type gatewayFixture struct {
	RSS []struct {
		served
		URL       string          `json:"url"`
		Addresses json.RawMessage `json:"addresses"`
		Items     []struct {
			Key, Title, Link, Summary string
			PublishedAt               *string `json:"publishedAt"`
		} `json:"items"`
		Error string `json:"error"`
	} `json:"rss"`
	Official []struct {
		Call  string          `json:"call"`
		Case  *served         `json:"case"`
		Hex   *string         `json:"hex"`
		Query string          `json:"query"`
		Posts json.RawMessage `json:"posts"`
		Error string          `json:"error"`
		URL   string          `json:"url"`
	} `json:"official"`
}

func loadGateways(t *testing.T) gatewayFixture {
	t.Helper()
	data, err := os.ReadFile("../testdata/domain.json")
	if err != nil {
		t.Fatal(err)
	}
	var f gatewayFixture
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

// serve answers every request with the case; a case that throws drops the connection.
func serve(c served, hexBody *string, longTitle func(int) string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		if c.Throws {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = conn.Close()
			}
			return
		}
		var body []byte
		switch {
		case c.Large > 0:
			body = []byte(strings.Repeat("x", c.Large))
		case c.Long > 0:
			body = []byte(longTitle(c.Long))
		case hexBody != nil:
			body, _ = hex.DecodeString(*hexBody)
		}
		for k, v := range c.Headers {
			w.Header().Set(k, v)
		}
		if c.Status >= 300 && c.Status < 400 {
			w.Header().Set("Location", "https://otro.example/")
		}
		w.WriteHeader(c.Status)
		_, _ = w.Write(body)
	}
}

func insecure(t *http.Transport) { t.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} }

func TestRSSGatewayMatchesTypeScript(t *testing.T) {
	for i, c := range loadGateways(t).RSS {
		srv := httptest.NewTLSServer(serve(c.served, c.Hex, nil))
		var dialled atomic.Value
		g := RSS{
			Resolve: func(context.Context, string) ([]netip.Addr, error) {
				var list []string
				if json.Unmarshal(c.Addresses, &list) != nil {
					return nil, errors.New("ENOTFOUND")
				}
				addrs := make([]netip.Addr, len(list))
				for j, a := range list {
					addrs[j] = netip.MustParseAddr(a)
				}
				return addrs, nil
			},
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				dialled.Store(address)
				return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
			},
			Transport: insecure,
		}
		url := c.URL
		if url == "" {
			url = "https://diario.example/rss"
		}
		items, err := g.Read(context.Background(), url)
		srv.Close()
		var fe *domain.FeedError
		switch {
		case c.Error != "":
			if !errors.As(err, &fe) || fe.Code != c.Error {
				t.Errorf("case %d: %v, TypeScript %s", i, err, c.Error)
			}
			continue
		case err != nil:
			t.Errorf("case %d: %v, TypeScript %d items", i, err, len(c.Items))
			continue
		}
		if got, _ := dialled.Load().(string); !strings.HasSuffix(got, ":443") {
			t.Errorf("case %d: dialled %q, want a checked address on port 443", i, got)
		}
		if len(items) != len(c.Items) {
			t.Errorf("case %d: %d items, TypeScript %d", i, len(items), len(c.Items))
			continue
		}
		for j, want := range c.Items {
			got := items[j]
			if got.Key != want.Key || records.WellFormed(got.Title) != want.Title || got.Link != want.Link ||
				got.Summary != want.Summary || deref(got.PublishedAt) != deref(want.PublishedAt) {
				t.Errorf("case %d item %d: %+v, TypeScript %+v", i, j, got, want)
			}
		}
	}
}

func deref(s *string) string {
	if s == nil {
		return "null"
	}
	return *s
}

func longTitlePost(n int) string {
	post := map[string]any{
		"id": 7, "link": "https://www.defensoria.gob.pe/nota-7/", "date_gmt": "2026-10-01T10:00:00",
		"title":   map[string]string{"rendered": strings.Repeat("x", n)},
		"excerpt": map[string]string{"rendered": "<p>Extracto</p>"},
	}
	b, _ := json.Marshal([]any{post})
	return string(b)
}

func TestOfficialGatewayMatchesTypeScript(t *testing.T) {
	for i, c := range loadGateways(t).Official {
		var requested atomic.Value
		handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requested.Store(r.URL.RequestURI())
			if c.Case != nil {
				serve(*c.Case, c.Hex, longTitlePost)(w, r)
				return
			}
			_, _ = w.Write([]byte("[]"))
		})
		srv := httptest.NewTLSServer(handler)
		g := Official{Base: srv.URL + "/wp-json/wp/v2/posts", Client: srv.Client()}
		var (
			posts []domain.OfficialPost
			err   error
		)
		switch c.Call {
		case "preview":
			posts, err = g.Preview(context.Background(), "agua & ñ+x")
		case "get":
			var p domain.OfficialPost
			if p, err = g.Get(context.Background(), 7); err == nil {
				posts = []domain.OfficialPost{p}
			}
		case "query":
			posts, err = g.Preview(context.Background(), c.Query)
		}
		srv.Close()
		if c.URL != "" {
			want := strings.TrimPrefix(c.URL, "https://www.defensoria.gob.pe")
			if got, _ := requested.Load().(string); got != want {
				t.Errorf("case %d %s: requested %q, TypeScript %q", i, c.Call, got, want)
			}
		}
		var se *domain.SourceError
		if c.Error != "" {
			if !errors.As(err, &se) || se.Code != c.Error {
				t.Errorf("case %d %s: %v, TypeScript %s", i, c.Call, err, c.Error)
			}
			continue
		}
		if err != nil {
			t.Errorf("case %d %s: %v", i, c.Call, err)
			continue
		}
		var want []domain.OfficialPost
		if err := json.Unmarshal(c.Posts, &want); err != nil {
			t.Fatal(err)
		}
		if len(posts) != len(want) {
			t.Errorf("case %d %s: %d posts, TypeScript %d", i, c.Call, len(posts), len(want))
			continue
		}
		for j := range want {
			if posts[j] != want[j] {
				t.Errorf("case %d %s post %d:\n got  %+v\n want %+v", i, c.Call, j, posts[j], want[j])
			}
		}
	}
}

// slow answers after the client gave up.
func slow(release <-chan struct{}) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		select {
		case <-release:
		case <-time.After(5 * time.Second):
		}
		_, _ = w.Write([]byte("[]"))
	}
}

func TestGatewaysTimeOut(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewTLSServer(slow(release))
	defer srv.Close()
	defer close(release)
	rss := RSS{
		Resolve: func(context.Context, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("203.0.113.10")}, nil
		},
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
		},
		Transport: insecure,
		Timeout:   50 * time.Millisecond,
	}
	var fe *domain.FeedError
	if _, err := rss.Read(context.Background(), "https://diario.example/rss"); !errors.As(err, &fe) || fe.Code != domain.FeedTimeout {
		t.Errorf("feed: %v, want feed_timeout", err)
	}
	official := Official{Base: srv.URL, Client: srv.Client(), Timeout: 50 * time.Millisecond}
	var se *domain.SourceError
	if _, err := official.Get(context.Background(), 7); !errors.As(err, &se) || se.Code != domain.SourceTimeout {
		t.Errorf("official: %v, want source_timeout", err)
	}
}

// The connection goes to the address that was checked, never to a second resolution, and the
// socket itself refuses private addresses.
func TestRSSGatewayConnectsOnlyToCheckedPublicAddresses(t *testing.T) {
	var dialled []string
	g := RSS{
		Resolve: func(context.Context, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("2606:4700::1")}, nil
		},
		Dial: func(_ context.Context, _, address string) (net.Conn, error) {
			dialled = append(dialled, address)
			return nil, errors.New("refused")
		},
	}
	var fe *domain.FeedError
	if _, err := g.Read(context.Background(), "https://diario.example/rss"); !errors.As(err, &fe) || fe.Code != domain.FeedUnavailable {
		t.Errorf("%v, want feed_unavailable", err)
	}
	if len(dialled) != 1 || dialled[0] != "[2606:4700::1]:443" {
		t.Errorf("dialled %q, want only the checked address", dialled)
	}
	for _, address := range []string{"127.0.0.1:443", "10.1.2.3:443", "[::1]:443", "[::ffff:169.254.169.254]:80", "[fe80::1]:443", "[64:ff9b::a00:1]:443", "0.0.0.0:443"} {
		if err := publicOnly("tcp", address, nil); !errors.Is(err, errBlocked) {
			t.Errorf("%s: %v, want blocked", address, err)
		}
	}
	if err := publicOnly("tcp", "93.184.216.34:443", nil); err != nil {
		t.Errorf("public address refused: %v", err)
	}
	// Without a test dialler, a private answer never reaches a socket.
	g = RSS{Resolve: func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
	}}
	if _, err := g.Read(context.Background(), "https://diario.example/rss"); !errors.As(err, &fe) || fe.Code != domain.FeedBlockedAddress {
		t.Errorf("%v, want feed_blocked_address", err)
	}
}

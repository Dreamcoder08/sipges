package infrastructure

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"net/netip"
	"regexp"
	"strconv"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The outbound reads of the integration runtime, with the egress limits of rss-feed-gateway.ts
// and official-source.ts: https only, no redirects, a whole-request deadline and a byte cap, and
// for feeds a host that must resolve only to public addresses. Neither uses a proxy from the
// environment (Node's fetch does not either).

// Resolver resolves a host name to its addresses.
type Resolver func(ctx context.Context, host string) ([]netip.Addr, error)

func systemResolve(ctx context.Context, host string) ([]netip.Addr, error) {
	return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
}

// errBlocked is a connection refused because its address is private.
var errBlocked = errors.New("integration: connection to a private address")

// publicOnly refuses, at connect time, any socket to a private address: the addresses dialled
// are the ones already checked, and this keeps a later change of the dial path from reaching
// the internal network.
func publicOnly(_, address string, _ syscall.RawConn) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil || domain.IsPrivateAddress(ap.Addr()) {
		return errBlocked
	}
	return nil
}

// RSS reads public RSS/Atom feeds (docs/adr/0021 §1): the host must resolve to public addresses
// only, the connection goes to one of those addresses (a second DNS answer cannot move it to the
// internal network), no redirects, at most 8 s and 1 MB.
type RSS struct {
	Resolve Resolver
	// Dial overrides the connection (tests); it receives the checked address and port.
	Dial     func(ctx context.Context, network, address string) (net.Conn, error)
	Timeout  time.Duration
	MaxBytes int64
	// TLS overrides the transport's TLS settings (tests).
	Transport func(t *http.Transport)
}

const (
	rssTimeout   = 8 * time.Second
	rssMaxBytes  = 1024 * 1024
	rssAccept    = "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8"
	rssUserAgent = "SIPGES-Monitoreo/1.0 (+https://github.com/Dreamcoder08/sipges)"
)

func feedError(code string) error { return &domain.FeedError{Code: code} }

var legacyEncoding = regexp.MustCompile(`encoding=["']((?i:iso-8859-1|latin1|windows-1252))["']`)

// Read is gateway.read: the feed's items or a *domain.FeedError.
func (g RSS) Read(ctx context.Context, url string) ([]domain.FeedItem, error) {
	if domain.FeedURLProblem(url) != "" {
		return nil, feedError(domain.FeedInvalidURL)
	}
	u, _ := domain.ParseURL(url)
	resolve := g.Resolve
	if resolve == nil {
		resolve = systemResolve
	}
	addresses, err := resolve(ctx, u.Hostname)
	if err != nil || len(addresses) == 0 {
		return nil, feedError(domain.FeedUnresolved)
	}
	for _, a := range addresses {
		if domain.IsPrivateAddress(a) {
			return nil, feedError(domain.FeedBlockedAddress)
		}
	}
	timeout, maxBytes := g.Timeout, g.MaxBytes
	if timeout == 0 {
		timeout = rssTimeout
	}
	if maxBytes == 0 {
		maxBytes = rssMaxBytes
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	body, status, err := g.fetch(ctx, u.Href, addresses[0], maxBytes)
	switch {
	case err == nil:
	case errors.Is(err, errBlocked):
		return nil, feedError(domain.FeedBlockedAddress)
	case errors.As(err, new(*domain.FeedError)):
		return nil, err
	case ctx.Err() != nil:
		return nil, feedError(domain.FeedTimeout)
	default:
		return nil, feedError(domain.FeedUnavailable)
	}
	_ = status
	text := decodeFeed(body)
	items := domain.ParseFeed(text)
	if len(items) == 0 && !domain.IsFeedDocument(text) {
		return nil, feedError(domain.FeedNotAFeed)
	}
	return items, nil
}

func (g RSS) fetch(ctx context.Context, href string, address netip.Addr, maxBytes int64) ([]byte, int, error) {
	dialer := &net.Dialer{Control: publicOnly}
	transport := &http.Transport{
		Proxy:             nil,
		DisableKeepAlives: true,
		ForceAttemptHTTP2: true,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			_, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			target := net.JoinHostPort(address.String(), port)
			if g.Dial != nil {
				if domain.IsPrivateAddress(address) {
					return nil, errBlocked
				}
				return g.Dial(ctx, network, target)
			}
			return dialer.DialContext(ctx, network, target)
		},
	}
	if g.Transport != nil {
		g.Transport(transport)
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, href, nil)
	if err != nil {
		return nil, 0, feedError(domain.FeedUnavailable)
	}
	req.Header.Set("Accept", rssAccept)
	req.Header.Set("User-Agent", rssUserAgent)
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	switch {
	case resp.StatusCode >= 300 && resp.StatusCode < 400:
		return nil, 0, feedError(domain.FeedRedirect)
	case resp.StatusCode < 200 || resp.StatusCode > 299 || resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusResetContent:
		return nil, 0, feedError(domain.FeedUnavailable)
	}
	if declared(resp) > float64(maxBytes) {
		return nil, 0, feedError(domain.FeedTooLarge)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, 0, err
	}
	if int64(len(body)) > maxBytes {
		return nil, 0, feedError(domain.FeedTooLarge)
	}
	return body, resp.StatusCode, nil
}

// declared is Number(response.headers.get('content-length')): 0 when absent, NaN when it is no
// number.
func declared(resp *http.Response) float64 {
	values := resp.Header.Values("Content-Length")
	if len(values) == 0 {
		if resp.ContentLength > 0 {
			return float64(resp.ContentLength)
		}
		return 0
	}
	n := domain.NumberJS(values[0])
	if math.IsNaN(n) {
		return 0
	}
	return n
}

// windows1252 is the WHATWG windows-1252 decoder's table for bytes 0x80–0x9F.
var windows1252 = [32]rune{
	0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
	0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178,
}

// decodeFeed is the gateway's decoding: windows-1252 when the XML declaration in the first 200
// bytes names ISO-8859-1, latin1 or windows-1252, otherwise UTF-8 (a BOM dropped, invalid
// sequences replaced).
func decodeFeed(body []byte) string {
	if legacyEncoding.Match(body[:min(len(body), 200)]) {
		var b bytes.Buffer
		for _, c := range body {
			switch {
			case c >= 0x80 && c <= 0x9F:
				b.WriteRune(windows1252[c-0x80])
			default:
				b.WriteRune(rune(c))
			}
		}
		return b.String()
	}
	return records.DecodeUTF8(body)
}

// Official reads the Defensoría's WordPress API (official-source.ts): its fixed host only,
// 5 s, 512 KiB, ten posts at most, any redirect refused.
type Official struct {
	// Base is the endpoint; empty means the official https://www.defensoria.gob.pe/wp-json/wp/v2/posts.
	Base     string
	Client   *http.Client
	Timeout  time.Duration
	MaxBytes int64
}

const (
	officialBase     = "https://" + domain.OfficialHost + "/wp-json/wp/v2/posts"
	officialTimeout  = 5 * time.Second
	officialMaxBytes = 512 * 1024
)

func sourceError(code string) error { return &domain.SourceError{Code: code} }

// Preview is gateway.preview: ten posts matching the query.
func (o Official) Preview(ctx context.Context, query string) ([]domain.OfficialPost, error) {
	if domain.Len16(query) > 100 || bytes.IndexByte([]byte(query), 0) >= 0 {
		return nil, sourceError(domain.SourceInvalidQuery)
	}
	return o.read(ctx, "per_page", "10", "search", query)
}

// Get is gateway.get: one post by id.
func (o Official) Get(ctx context.Context, id int) (domain.OfficialPost, error) {
	if id <= 0 || id > math.MaxInt32 {
		return domain.OfficialPost{}, sourceError(domain.SourceInvalidID)
	}
	posts, err := o.read(ctx, "include", strconv.Itoa(id), "per_page", "1")
	if err != nil {
		return domain.OfficialPost{}, err
	}
	for _, p := range posts {
		if p.ID == id {
			return p, nil
		}
	}
	return domain.OfficialPost{}, sourceError(domain.SourceNotFound)
}

func (o Official) read(ctx context.Context, pairs ...string) ([]domain.OfficialPost, error) {
	base, timeout, maxBytes, client := o.Base, o.Timeout, o.MaxBytes, o.Client
	if base == "" {
		base = officialBase
	}
	if timeout == 0 {
		timeout = officialTimeout
	}
	if maxBytes == 0 {
		maxBytes = officialMaxBytes
	}
	if client == nil {
		client = &http.Client{Transport: &http.Transport{Proxy: nil, ForceAttemptHTTP2: true}}
	}
	// redirect: 'error': any redirect fails the request.
	strict := *client
	strict.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("redirect") }
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	posts, err := o.fetch(ctx, &strict, base+"?"+domain.OfficialQuery(append(pairs, "_fields", "id,link,date_gmt,title,excerpt")...), maxBytes)
	switch {
	case err == nil:
		return posts, nil
	case errors.As(err, new(*domain.SourceError)):
		return nil, err
	case ctx.Err() != nil:
		return nil, sourceError(domain.SourceTimeout)
	}
	return nil, sourceError(domain.SourceInvalidData)
}

func (o Official) fetch(ctx context.Context, client *http.Client, url string, maxBytes int64) ([]domain.OfficialPost, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, sourceError(domain.SourceUnavailable)
	}
	if declared(resp) > float64(maxBytes) {
		return nil, sourceError(domain.SourceTooLarge)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxBytes {
		return nil, sourceError(domain.SourceTooLarge)
	}
	return officialPosts(body)
}

// officialPosts is the zod check of the answer (an array of at most ten posts, each with a
// positive integer id, string link and date_gmt, and title and excerpt objects with a string
// `rendered` of at most 100 000 characters) and the per-post checks; any failure is
// source_invalid_data. Keys are matched exactly, the last duplicate winning, as in JSON.parse.
func officialPosts(body []byte) ([]domain.OfficialPost, error) {
	invalid := sourceError(domain.SourceInvalidData)
	dec := json.NewDecoder(bytes.NewReader([]byte(records.DecodeUTF8(body))))
	dec.UseNumber()
	var rows []json.RawMessage
	if err := dec.Decode(&rows); err != nil || dec.More() || len(rows) > 10 {
		return nil, invalid
	}
	type row struct {
		id                         float64
		link, date, title, excerpt string
	}
	checked := make([]row, 0, len(rows))
	for _, raw := range rows {
		fields, ok := object(raw)
		if !ok {
			return nil, invalid
		}
		var r row
		var idText json.Number
		if json.Unmarshal(fields["id"], &idText) != nil || bytes.HasPrefix(bytes.TrimSpace(fields["id"]), []byte(`"`)) {
			return nil, invalid
		}
		id, err := strconv.ParseFloat(string(idText), 64)
		if err != nil || id != math.Trunc(id) || id <= 0 || id > math.MaxInt32 {
			return nil, invalid
		}
		r.id = id
		if !jsonString(fields["link"], &r.link) || !jsonString(fields["date_gmt"], &r.date) ||
			!rendered(fields["title"], &r.title) || !rendered(fields["excerpt"], &r.excerpt) {
			return nil, invalid
		}
		checked = append(checked, r)
	}
	posts := make([]domain.OfficialPost, 0, len(checked))
	for _, r := range checked {
		post, ok := domain.OfficialPostFrom(int(r.id), r.link, r.date, r.title, r.excerpt)
		if !ok {
			return nil, invalid
		}
		posts = append(posts, post)
	}
	return posts, nil
}

// object decodes a JSON object with exact, last-wins keys.
func object(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, false
	}
	fields := map[string]json.RawMessage{}
	for dec.More() {
		tok, err := dec.Token()
		key, isKey := tok.(string)
		if err != nil || !isKey {
			return nil, false
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, false
		}
		fields[key] = value
	}
	return fields, true
}

func jsonString(raw json.RawMessage, to *string) bool {
	return len(raw) > 0 && raw[0] == '"' && json.Unmarshal(raw, to) == nil
}

func rendered(raw json.RawMessage, to *string) bool {
	fields, ok := object(raw)
	return ok && jsonString(fields["rendered"], to) && utf8.RuneCountInString(*to) <= 100000
}

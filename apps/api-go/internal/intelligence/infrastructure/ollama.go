package infrastructure

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/domain"
	privacy "github.com/Dreamcoder08/sipges/apps/api-go/internal/privacy/application"
)

// The bounds of ollama-embeddings.ts.
const (
	embedTimeout       = 12 * time.Second
	maxResponseBytes   = 1_500_000
	maxInputCodePoints = 12_000
	minVectorLength    = 8
)

// Ollama calls an Ollama server (POST /api/embed), the port of ollama-embeddings.ts. Only the
// configured base URL is ever contacted; request text never selects a host, redirects fail the
// call and proxy variables are ignored. A host that is not loopback is external AI: its callers
// clear every text with the egress guard first, and the compiler enforces it through
// privacy.Sanitised. Embed's errors are fixed texts, so neither the URL nor the text reach a log.
//
// One difference from TypeScript: no traceparent header, since this API has no trace context.
type Ollama struct {
	endpoint    string
	credentials bool
	model       string
	egress      string
	client      *http.Client
}

// NewOllama builds the client for a base URL already validated by config.LoadOllama.
func NewOllama(baseURL, model string) (*Ollama, error) {
	base, err := url.Parse(baseURL)
	if err != nil {
		return nil, errors.New("embeddings: unusable base URL")
	}
	endpoint := url.URL{Scheme: base.Scheme, Host: base.Host, Path: "/api/embed"}
	transport, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return nil, errors.New("embeddings: unexpected default transport")
	}
	transport = transport.Clone()
	transport.Proxy = nil
	egress := application.EgressExternal
	if isLoopback(base.Hostname()) {
		egress = application.EgressLocal
	}
	return &Ollama{
		endpoint: endpoint.String(), credentials: base.User != nil, model: model, egress: egress,
		client: &http.Client{
			Transport: transport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return errors.New("embeddings: redirect refused")
			},
		},
	}, nil
}

// isLoopback says a host is on this machine, so the text never crosses a network. TypeScript reads
// a host normalised by the URL parser; here anything but the plain spellings is external, which
// only ever means the text goes through the guard. An address must parse: «127.999.0.1» is a name.
func isLoopback(host string) bool {
	if strings.ToLower(host) == "localhost" {
		return true
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	return addr == netip.IPv6Loopback() || (addr.Is4() && addr.As4()[0] == 127)
}

// Model is the configured model.
func (o *Ollama) Model() string { return o.model }

// Egress is application.EgressLocal or application.EgressExternal.
func (o *Ollama) Egress() string { return o.egress }

// Embed returns the text's vector; it fails when the model is not reachable or answers anything
// but a valid vector.
func (o *Ollama) Embed(ctx context.Context, text privacy.Sanitised[string]) ([]float64, error) {
	if o.credentials {
		return nil, errors.New("embeddings: credentials in the service URL")
	}
	var payload bytes.Buffer
	encoder := json.NewEncoder(&payload)
	encoder.SetEscapeHTML(false)
	err := encoder.Encode(struct {
		Model string `json:"model"`
		Input string `json:"input"`
	}{o.model, domain.FirstCodePoints(text.Value(), maxInputCodePoints)})
	if err != nil {
		return nil, errors.New("embeddings: unencodable request")
	}
	ctx, cancel := context.WithTimeout(ctx, embedTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.endpoint, &payload)
	if err != nil {
		return nil, errors.New("embeddings: unusable request")
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := o.client.Do(req)
	if err != nil {
		return nil, errors.New("embeddings: service unreachable") // the wrapped error holds the URL
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("embeddings: service answered %d", res.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes+1))
	if err != nil {
		return nil, errors.New("embeddings: unreadable response")
	}
	if len(body) > maxResponseBytes {
		return nil, errors.New("embeddings: response too large")
	}
	return parseVector(body)
}

// parseVector reads the first vector. Keys match exactly, as in JavaScript, and an entry that is
// not a number (null included) refuses the vector.
func parseVector(body []byte) ([]float64, error) {
	invalid := errors.New("embeddings: no valid vector")
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, invalid
	}
	var vectors []json.RawMessage
	if err := json.Unmarshal(parsed["embeddings"], &vectors); err != nil || len(vectors) == 0 {
		return nil, invalid
	}
	var entries []*float64
	if err := json.Unmarshal(vectors[0], &entries); err != nil || len(entries) < minVectorLength {
		return nil, invalid
	}
	vector := make([]float64, len(entries))
	for i, entry := range entries {
		if entry == nil {
			return nil, invalid
		}
		vector[i] = *entry
	}
	return vector, nil
}

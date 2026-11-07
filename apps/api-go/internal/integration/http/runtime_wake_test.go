//nolint:misspell // Spanish module slugs, verbatim from the API.
package http_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	integrationhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

const keyTenant = "SIPGES/PRJ-SECHURA"

type verifiedKey struct {
	integrationhttp.KeyService
	access string
}

func (k verifiedKey) Authenticate(context.Context, string, bool) (*domain.Principal, error) {
	if k.access == "" {
		return nil, nil
	}
	return &domain.Principal{TenantID: keyTenant, Access: k.access}, nil
}

type fixedIngest struct{ outcome application.Outcome }

func (f fixedIngest) Run(context.Context, application.IngestRequest) (application.Outcome, error) {
	return f.outcome, nil
}

func outcome(status int, replayed bool) application.Outcome {
	return application.Outcome{Response: application.Response{Status: status, Body: []byte(`{}`)}, Replayed: replayed}
}

// Only a write that landed reports a tenant, and it is always the key's.
func TestAWebhookReportsItsKeysTenantOnlyAfterAWrite(t *testing.T) {
	signal := `{"source_url":"https://example.org/a","source_name":"Sintética","external_id":"1","text":"Texto sintético","observed_at":"2026-11-01T00:00:00Z"}`
	for name, c := range map[string]struct {
		key     string
		outcome application.Outcome
		want    string
	}{
		"created":         {"write", outcome(201, false), keyTenant},
		"partly created":  {"write", outcome(207, false), keyTenant},
		"replayed":        {"write", outcome(201, true), ""},
		"replayed partly": {"write", outcome(207, true), ""},
		"in progress":     {"write", outcome(409, false), ""},
		"unknown module":  {"write", outcome(404, false), ""},
		"nothing valid":   {"write", outcome(422, false), ""},
		"read-only key":   {"read", outcome(201, false), ""},
		"unknown key":     {"", outcome(201, false), ""},
	} {
		for path, body := range map[string]string{"/hooks/ingest/narrativas": `{"a":1}`, "/hooks/signals": signal} {
			t.Run(name+" "+path, func(t *testing.T) {
				mux := http.NewServeMux()
				integrationhttp.RegisterRuntime(mux, integrationhttp.Runtime{
					Keys: verifiedKey{access: c.key}, Ingest: fixedIngest{c.outcome},
				})
				r := httptest.NewRequestWithContext(t.Context(), http.MethodPost, path, strings.NewReader(body))
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set("Authorization", "Bearer x")
				r.Header.Set("X-SIPGES-Scope", "ACME/NORTE")
				ctx, reported := httpx.WatchMachineTenant(r.Context())
				mux.ServeHTTP(httptest.NewRecorder(), r.WithContext(ctx))
				if got := reported(); got != c.want {
					t.Fatalf("reported %q, want %q", got, c.want)
				}
			})
		}
	}
}

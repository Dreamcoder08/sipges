package http_test

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/domain"
	integrationhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/integration/http"
)

// /mcp against the answers testdata/mcp.mjs recorded from the real Hono routes: same status, media
// type and WWW-Authenticate, and the same body byte for byte. The tools run over no database here;
// internal/app covers them against PostgreSQL.

type mcpCase struct {
	Label           string  `json:"label"`
	Method          string  `json:"method"`
	Host            string  `json:"host"`
	Origin          *string `json:"origin"`
	Key             *string `json:"key"`
	Body            *string `json:"body"`
	Hex             *string `json:"hex"`
	Status          int     `json:"status"`
	ContentType     *string `json:"content_type"`
	WWWAuthenticate *string `json:"www_authenticate"`
	Response        string  `json:"response"`
}

// mcpKeys is the generator's fake key service.
type mcpKeys struct{ KeyServiceDouble }

func (mcpKeys) Authenticate(_ context.Context, header string, present bool) (*domain.Principal, error) {
	token, ok := domain.BearerToken(header, present)
	if !ok {
		return nil, nil
	}
	tenant := "SIPGES/PRJ-SECHURA"
	switch token {
	case "clave-lectura":
		return &domain.Principal{KeyID: 1, TenantID: tenant, Name: "lectura", Access: "read", Clearance: "full"}, nil
	case "clave-escritura":
		return &domain.Principal{KeyID: 2, TenantID: tenant, Name: "escritura", Access: "write", Clearance: "full"}, nil
	}
	return nil, nil
}

// KeyServiceDouble refuses everything but Authenticate.
type KeyServiceDouble struct{ integrationhttp.KeyService }

func TestMCPAnswersAsTheTypeScriptRoutes(t *testing.T) {
	raw, err := os.ReadFile("../testdata/mcp.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Routes []mcpCase `json:"routes"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Routes) < 90 {
		t.Fatalf("only %d cases", len(fixture.Routes))
	}
	mux := http.NewServeMux()
	integrationhttp.RegisterMCP(mux, integrationhttp.MCP{Keys: mcpKeys{}, Tools: application.MCP{}})
	for _, c := range fixture.Routes {
		t.Run(c.Label, func(t *testing.T) {
			var body strings.Builder
			if c.Body != nil {
				body.WriteString(*c.Body)
			}
			if c.Hex != nil {
				decoded, err := hex.DecodeString(*c.Hex)
				if err != nil {
					t.Fatal(err)
				}
				body.Write(decoded)
			}
			req := httptest.NewRequest(c.Method, "http://mcp.example:8080/mcp", strings.NewReader(body.String()))
			req.Host = c.Host
			if c.Origin != nil {
				req.Header.Set("Origin", *c.Origin)
			}
			if c.Key != nil {
				req.Header.Set("Authorization", "Bearer "+*c.Key)
			}
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			if rec.Code != c.Status {
				t.Errorf("status %d, want %d", rec.Code, c.Status)
			}
			if got := strings.TrimSuffix(rec.Body.String(), "\n"); got != c.Response {
				t.Errorf("body\n got %s\nwant %s", got, c.Response)
			}
			if got, want := rec.Header().Get("Content-Type"), deref(c.ContentType); got != want {
				t.Errorf("content type %q, want %q", got, want)
			}
			if got, want := rec.Header().Get("WWW-Authenticate"), deref(c.WWWAuthenticate); got != want {
				t.Errorf("WWW-Authenticate %q, want %q", got, want)
			}
		})
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

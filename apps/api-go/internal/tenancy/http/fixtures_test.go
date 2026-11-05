package http

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	identity "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

// The TypeScript routes' answers, recorded by ../testdata/generate.mjs over the real
// tenancy-routes.ts and tenancy-service.ts with an in-memory store.

type fixtureRow struct {
	CompanyID string `json:"company_id,omitempty"`
	ProjectID string `json:"project_id,omitempty"`
	Label     string `json:"label,omitempty"`
	Username  string `json:"username,omitempty"`
	TenantID  string `json:"tenant_id,omitempty"`
}

type fixtureState struct {
	Tenants []fixtureRow `json:"tenants"`
	Grants  []fixtureRow `json:"grants"`
}

type fixture struct {
	Name        string `json:"name"`
	Method      string `json:"method"`
	Path        string `json:"path"`
	Actor       string `json:"actor"`
	Cookie      string `json:"cookie"`
	ContentType string `json:"contentType"`
	Body        string `json:"body"`
	Want        struct {
		Status      int          `json:"status"`
		ContentType string       `json:"contentType"`
		Location    string       `json:"location"`
		SetCookie   string       `json:"setCookie"`
		Body        string       `json:"body"`
		State       fixtureState `json:"state"`
	} `json:"want"`
}

func initialState() fixtureState {
	return fixtureState{
		Tenants: []fixtureRow{
			{CompanyID: "SIPGES", ProjectID: "PRJ-SECHURA", Label: "Proyecto Sechura (migración)"},
			{CompanyID: "ACME", ProjectID: "EXISTE", Label: `<b>"Acme" & 'Co'</b>`},
		},
		Grants: []fixtureRow{
			{Username: "admin", TenantID: "SIPGES/PRJ-SECHURA"},
			{Username: "admin", TenantID: "ACME/EXISTE"},
			{Username: "ana.perez", TenantID: "ACME/EXISTE"},
		},
	}
}

// memoryStore is generate.mjs's memoryStore.
type memoryStore struct{ state *fixtureState }

func (m memoryStore) find(s domain.Scope) *fixtureRow {
	for i, t := range m.state.Tenants {
		if t.CompanyID == s.CompanyID && t.ProjectID == s.ProjectID {
			return &m.state.Tenants[i]
		}
	}
	return nil
}

func (m memoryStore) grantIndex(username, tenantID string) int {
	return slices.IndexFunc(m.state.Grants, func(g fixtureRow) bool { return g.Username == username && g.TenantID == tenantID })
}

func (m memoryStore) CreateTenantWithGrant(_ context.Context, t domain.NewTenant, _ time.Time) (bool, error) {
	if m.find(t.Scope) != nil {
		return false, nil
	}
	m.state.Tenants = append(m.state.Tenants, fixtureRow{CompanyID: t.CompanyID, ProjectID: t.ProjectID, Label: t.Label})
	m.state.Grants = append(m.state.Grants, fixtureRow{Username: t.Username, TenantID: t.TenantID()})
	return true, nil
}

func (m memoryStore) TenantExists(_ context.Context, s domain.Scope) (bool, error) {
	return m.find(s) != nil, nil
}

func (m memoryStore) Grant(_ context.Context, username string, s domain.Scope, _ time.Time) error {
	if m.grantIndex(username, s.TenantID()) < 0 {
		m.state.Grants = append(m.state.Grants, fixtureRow{Username: username, TenantID: s.TenantID()})
	}
	return nil
}

func (m memoryStore) Revoke(_ context.Context, username string, s domain.Scope) (bool, error) {
	i := m.grantIndex(username, s.TenantID())
	if i < 0 {
		return false, nil
	}
	m.state.Grants = slices.Delete(m.state.Grants, i, i+1)
	return true, nil
}

func (m memoryStore) ListGrants(_ context.Context, username string) ([]domain.Grant, error) {
	var out []domain.Grant
	for _, g := range m.state.Grants {
		if g.Username != username {
			continue
		}
		for _, t := range m.state.Tenants {
			if t.CompanyID+"/"+t.ProjectID == g.TenantID {
				out = append(out, domain.Grant{Scope: domain.Scope{CompanyID: t.CompanyID, ProjectID: t.ProjectID}, Label: t.Label})
			}
		}
	}
	slices.SortFunc(out, func(a, b domain.Grant) int {
		return strings.Compare(a.CompanyID+"\x00"+a.ProjectID, b.CompanyID+"\x00"+b.ProjectID)
	})
	return out, nil
}

var fixtureUsers = []string{"admin", "ana.perez", "luis.diaz", strings.Repeat("x", 120), strings.Repeat("😀", 60)}

var fixturePrincipals = map[string]*identity.Principal{
	"admin":     {Username: "admin", Role: identity.RoleAdmin},
	"ana.perez": {Username: "ana.perez", Role: identity.RoleAnalyst},
}

type tokenSessions map[string]*identity.Principal

func (s tokenSessions) Authenticate(_ context.Context, token string) (*identity.Principal, error) {
	return s[token], nil
}

func fixtureHandler(state *fixtureState) http.Handler {
	mux := http.NewServeMux()
	RegisterAdmin(mux, AdminDeps{
		Admin: application.Admin{
			Store:  memoryStore{state: state},
			Users:  func(_ context.Context, u string) (bool, error) { return slices.Contains(fixtureUsers, u), nil },
			Forget: func(string) {},
		},
		Sessions:     tokenSessions{"admin-token": fixturePrincipals["admin"], "ana-token": fixturePrincipals["ana.perez"]},
		CookieSecure: true,
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p, ok := fixturePrincipals[r.Header.Get("X-Test-Actor")]; ok {
			r = r.WithContext(identityhttp.WithPrincipal(r.Context(), p))
		}
		mux.ServeHTTP(w, r)
	})
}

// TestFixtures sends every recorded request to the Go routes and compares the status, media
// type, Location, Set-Cookie, body (JSON as values, HTML as exact text) and stored rows.
func TestFixtures(t *testing.T) {
	raw, err := os.ReadFile("../testdata/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []fixture
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures) < 300 {
		t.Fatalf("only %d fixtures", len(fixtures))
	}
	for _, f := range fixtures {
		t.Run(f.Name, func(t *testing.T) {
			body, err := base64.StdEncoding.DecodeString(f.Body)
			if err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequestWithContext(t.Context(), f.Method, f.Path, bytes.NewReader(body))
			if f.Actor != "" {
				req.Header.Set("X-Test-Actor", f.Actor)
			}
			if f.Cookie != "" {
				req.Header.Set("Cookie", f.Cookie)
			}
			if f.ContentType != "" {
				req.Header.Set("Content-Type", f.ContentType)
			}
			state := initialState()
			rec := httptest.NewRecorder()
			fixtureHandler(&state).ServeHTTP(rec, req)

			res := rec.Result()
			if res.StatusCode != f.Want.Status {
				t.Fatalf("status %d, want %d (body %s, want %s)", res.StatusCode, f.Want.Status, rec.Body, f.Want.Body)
			}
			for name, want := range map[string]string{
				"Content-Type": f.Want.ContentType, "Location": f.Want.Location, "Set-Cookie": f.Want.SetCookie,
			} {
				if got := res.Header.Get(name); got != want {
					t.Errorf("%s %q, want %q", name, got, want)
				}
			}
			got := rec.Body.String()
			if f.Method == http.MethodHead {
				got = ""
			}
			if strings.HasPrefix(f.Want.ContentType, "application/json") && f.Method != http.MethodHead {
				var gotJSON, wantJSON any
				if err := json.Unmarshal([]byte(got), &gotJSON); err != nil {
					t.Fatalf("body %q: %v", got, err)
				}
				_ = json.Unmarshal([]byte(f.Want.Body), &wantJSON)
				if !reflect.DeepEqual(gotJSON, wantJSON) {
					t.Errorf("body %s, want %s", got, f.Want.Body)
				}
			} else if got != f.Want.Body {
				t.Errorf("body %q, want %q", got, f.Want.Body)
			}
			if !reflect.DeepEqual(state, f.Want.State) {
				t.Errorf("state %+v, want %+v", state, f.Want.State)
			}
		})
	}
}

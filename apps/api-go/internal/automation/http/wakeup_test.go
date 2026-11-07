//nolint:misspell // Spanish module slugs, verbatim from the API.
package http_test

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	automationhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/automation/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
)

type dispatched struct{ tenants []string }

func (d *dispatched) Dispatch(tenant string) { d.tenants = append(d.tenants, tenant) }

// A webhook has no project scope: only the tenant its route reports wakes anything.
func TestWakeupOfMachinePaths(t *testing.T) {
	const tenant = "SIPGES/PRJ-SECHURA"
	for name, c := range map[string]struct {
		method, path string
		status       int
		reported     string
		want         []string
	}{
		"a webhook that wrote":         {http.MethodPost, "/hooks/ingest/narrativas", 201, tenant, []string{tenant}},
		"a partial webhook":            {http.MethodPost, "/hooks/ingest/narrativas", 207, tenant, []string{tenant}},
		"a signal that wrote":          {http.MethodPost, "/hooks/signals", 201, tenant, []string{tenant}},
		"a webhook that wrote nothing": {http.MethodPost, "/hooks/ingest/narrativas", 201, "", nil},
		"a refused webhook":            {http.MethodPost, "/hooks/ingest/narrativas", 403, tenant, nil},
		"a failed webhook":             {http.MethodPost, "/hooks/ingest/narrativas", 500, tenant, nil},
		"another machine path":         {http.MethodPost, "/hooks/otro", 201, tenant, nil},
		"the bare ingest path":         {http.MethodPost, "/hooks/ingest", 201, tenant, nil},
		"a read of a webhook path":     {http.MethodGet, "/hooks/ingest/narrativas", 200, tenant, nil},
	} {
		t.Run(name, func(t *testing.T) {
			runtime := &dispatched{}
			route := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if c.reported != "" {
					httpx.SetMachineTenant(r.Context(), c.reported)
				}
				w.WriteHeader(c.status)
			})
			r := httptest.NewRequestWithContext(t.Context(), c.method, c.path, nil)
			automationhttp.Wakeup(runtime)(route).ServeHTTP(httptest.NewRecorder(), r)
			if !slices.Equal(runtime.tenants, c.want) {
				t.Fatalf("dispatched %v, want %v", runtime.tenants, c.want)
			}
		})
	}
}

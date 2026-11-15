package app_test

import (
	"context"
	"encoding/base64"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
)

// A synthetic Defensoría WordPress API on loopback: no test reaches the real site.
type defensoriaDouble struct {
	mu    sync.Mutex
	asked []string
}

func (d *defensoriaDouble) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	d.asked = append(d.asked, r.URL.RequestURI())
	d.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte("[]"))
}

func (d *defensoriaDouble) requests() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.asked...)
}

func TestTheCronPollsTheDefensoriaEndpointTheEnvironmentNames(t *testing.T) {
	pool := cronPool(t)
	// Only the connector is under test: the synthetic feed stays off, so nothing resolves a host.
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `SELECT set_config('app.tenant_id', $1, true)`, cronTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `UPDATE media_feeds SET enabled = false`); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}

	double := &defensoriaDouble{}
	srv := httptest.NewServer(double)
	t.Cleanup(srv.Close)
	const secret = "cron-secret-synthetic-0123456789"
	t.Setenv("SIPGES_DEFENSORIA_URL", srv.URL+"/wp-json/wp/v2/posts")
	t.Setenv("SIPGES_CRON_SECRET", secret)
	t.Setenv("SIPGES_DATA_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	h, err := app.NewHandler(pool, app.Options{Logger: slog.New(slog.DiscardHandler), AutomationInterval: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	api := httptest.NewServer(h)
	t.Cleanup(api.Close)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, api.URL+"/system/automations/cron", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("cron answered %d", res.StatusCode)
	}
	want := "/wp-json/wp/v2/posts?per_page=10&search=sintetico&_fields=id%2Clink%2Cdate_gmt%2Ctitle%2Cexcerpt"
	if got := double.requests(); len(got) != 1 || got[0] != want {
		t.Fatalf("the double was asked %q, want [%q]", got, want)
	}
	var lastError string
	tx, err = pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(t.Context(), `SELECT set_config('app.tenant_id', $1, true)`, cronTenant); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(t.Context(), `SELECT last_poll_error FROM source_import_settings WHERE source_id = 'defensoria'`).Scan(&lastError); err != nil {
		t.Fatal(err)
	}
	if lastError != "" {
		t.Fatalf("last_poll_error = %q, want none", lastError)
	}
}

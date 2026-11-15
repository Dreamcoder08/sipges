package http_test

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestThePreviewAsksTheDefensoriaEndpointTheEnvironmentNames(t *testing.T) {
	var asked atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked.Store(r.URL.RequestURI())
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("[]"))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("SIPGES_DEFENSORIA_URL", srv.URL+"/wp-json/wp/v2/posts")
	base := start(t)
	code, body := get(t, base, "/system/intelligence/sources/defensoria/preview?query=agua", "multi", sechuraScope)
	expect(t, code, body, http.StatusOK, "[]")
	const want = "/wp-json/wp/v2/posts?per_page=10&search=agua&_fields=id%2Clink%2Cdate_gmt%2Ctitle%2Cexcerpt"
	if got, _ := asked.Load().(string); got != want {
		t.Fatalf("the double was asked %q, want %q", got, want)
	}
}

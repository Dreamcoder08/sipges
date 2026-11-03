package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPathParamDecodesLikeHono(t *testing.T) {
	for target, want := range map[string]string{
		"/items/abc":        "abc",
		"/items/a%2Fb":      "a/b",
		"/items/a%252F":     "a%2F",
		"/items/%C3%B1":     "ñ",
		"/items/a%3Fb%23c":  "a?b#c",
		"/items/bad%E0%A4":  "bad%E0%A4",
		"/items/100%25":     "100%",
		"/items/a%20b%2Bc+": "a b+c+",
	} {
		var got string
		mux := http.NewServeMux()
		mux.HandleFunc("GET /items/{id}", func(_ http.ResponseWriter, r *http.Request) { got = PathParam(r, "id") })
		h := CanonicalPath()(mux)
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, target, nil))
		if got != want {
			t.Errorf("%s: PathParam = %q, want %q", target, got, want)
		}
	}
}

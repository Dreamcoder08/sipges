package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPathParamDecodesLikeHono(t *testing.T) {
	for target, want := range map[string]string{
		"/api/eventos/EV-1":         "EV-1",
		"/api/eventos/a%2Fb":        "a/b", // decodeURI keeps %2F in the path; the param decodes it
		"/api/eventos/100%25":       "100%",
		"/api/eventos/%C3%B1and%FF": "ñand%FF", // invalid as a whole: each run on its own…
		"/api/eventos/%23x%3F":      "#x?",
		"/api/eventos/%E2%82":       "%E2%82", // …and a run that does not decode stays
	} {
		var got string
		mux := http.NewServeMux()
		mux.HandleFunc("GET /api/{module}/{id}", func(_ http.ResponseWriter, r *http.Request) { got = PathParam(r, "id") })
		h := CanonicalPath()(mux)
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, target, nil))
		if got != want {
			t.Errorf("%s: %q, want %q", target, got, want)
		}
	}
}

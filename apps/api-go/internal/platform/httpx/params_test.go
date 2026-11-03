package httpx

import (
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIntQueryReadsLikeParseIntQuery(t *testing.T) {
	for query, want := range map[string]int64{"": 50, "?limit=7": 7, "?limit=%20-3%20": -3, "?limit=+4": 4,
		"?limit=99999999999999999999": math.MaxInt64, "?limit=-99999999999999999999": math.MinInt64} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/x"+query, nil)
		got, ok := IntQuery(w, r, "limit", 50)
		if !ok || got != want {
			t.Fatalf("%q: got %d %v, want %d", query, got, ok, want)
		}
	}
	for _, query := range []string{"?limit=", "?limit=1.5", "?limit=1e3", "?limit=--1", "?limit=%EF%BC%91"} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/x"+query, nil)
		if _, ok := IntQuery(w, r, "limit", 50); ok || w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%q: accepted (%d)", query, w.Code)
		}
		const want = `{"detail":[{"type":"int_parsing","loc":["query","limit"],"msg":"Input should be a valid integer, unable to parse string as an integer"}]}`
		if w.Body.String() != want {
			t.Fatalf("%q: body %s", query, w.Body.String())
		}
	}
}

func TestPathParamDecodesLikeHono(t *testing.T) {
	for raw, want := range map[string]string{"DIG-A": "DIG-A", "a%2Fb": "a/b", "100%": "100%", "%E0%A4%A": "%E0%A4%A"} {
		r := httptest.NewRequest(http.MethodGet, "/x", nil)
		r.SetPathValue("id", raw)
		if got := PathParam(r, "id"); got != want {
			t.Fatalf("PathParam(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestWriteJSONTextWritesLikeJSONStringify(t *testing.T) {
	w := httptest.NewRecorder()
	WriteJSONText(w, http.StatusOK, map[string]string{"a": "<b>&"})
	if w.Body.String() != `{"a":"<b>&"}` || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("got %s %q", w.Body.String(), w.Header().Get("Content-Type"))
	}
}

package http

import (
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

const intParsing = `{"detail":[{"type":"int_parsing","loc":["query","limit"],"msg":"Input should be a valid integer, unable to parse string as an integer"}]}`

func TestParseIntQueryReadsIntegersLikeTheTypeScriptHelper(t *testing.T) {
	valid := map[string]int64{
		"/x":                                 100, // absent: the fallback
		"/x?limit=5":                         5,
		"/x?limit=%20+7%20":                  7,
		"/x?limit=-3":                        -3,
		"/x?limit=007":                       7,
		"/x?limit=%C2%A012%E3%80%80":         12, // JavaScript \s includes NBSP and ideographic space
		"/x?limit=99999999999999999999":      math.MaxInt64,
		"/x?limit=-99999999999999999999":     math.MinInt64,
		"/x?limit=1&limit=abc":               1, // the first parameter wins
		"/x?other=1&limit=%2B42":             42,
		"/x?limit=%EF%BB%BF9":                9, // a byte order mark is JavaScript whitespace
		"/x?limit=%0B%0C9%E2%80%A8%E2%80%A9": 9,
	}
	for target, want := range valid {
		w := httptest.NewRecorder()
		got, ok := parseIntQuery(w, httptest.NewRequest(http.MethodGet, target, nil), "limit", 100)
		if !ok || got != want {
			t.Errorf("%s: got %d, %v; want %d", target, got, ok, want)
		}
	}
}

func TestParseIntQueryRefusesWhatIsNotAnInteger(t *testing.T) {
	for _, target := range []string{
		"/x?limit", "/x?limit=", "/x?limit=abc", "/x?limit=1.5", "/x?limit=1e3", "/x?limit=0x10",
		"/x?limit=%EF%BC%91", // fullwidth digit: JavaScript \d is ASCII only
		"/x?limit=1%202", "/x?limit=%2B-1", "/x?limit=-",
	} {
		w := httptest.NewRecorder()
		if _, ok := parseIntQuery(w, httptest.NewRequest(http.MethodGet, target, nil), "limit", 100); ok {
			t.Errorf("%s: accepted", target)
			continue
		}
		if w.Code != http.StatusUnprocessableEntity || w.Body.String() != intParsing {
			t.Errorf("%s: got %d %s", target, w.Code, w.Body.String())
		}
	}
}

func TestIsoSecondsIsUTCWithoutFractions(t *testing.T) {
	lima := time.FixedZone("x", -5*3600)
	cases := map[time.Time]string{
		time.Date(2026, 3, 4, 5, 6, 7, 987654321, time.UTC): "2026-03-04T05:06:07Z",
		time.Date(2026, 12, 31, 22, 0, 0, 0, lima):          "2027-01-01T03:00:00Z",
		time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC):        "+010000-01-01T00:00:00Z",
		time.Date(-1, 6, 1, 0, 0, 0, 0, time.UTC):           "-000001-06-01T00:00:00Z",
		time.Date(1, 1, 1, 0, 0, 0, 0, time.UTC):            "0001-01-01T00:00:00Z",
	}
	for in, want := range cases {
		if got := isoSeconds(in); got != want {
			t.Errorf("isoSeconds(%v) = %q, want %q", in, got, want)
		}
	}
}

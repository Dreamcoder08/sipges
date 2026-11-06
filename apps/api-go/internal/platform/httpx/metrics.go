package httpx

import (
	"bytes"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// buckets are the upper bounds in seconds of the request duration histogram.
var buckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}

type requestSeries struct{ method, route, status string }

type durationSeries struct{ method, route string }

type durations struct {
	count   int64
	sum     float64
	buckets []int64
}

// Metrics is createMetrics of apps/api/src/platform/observability/metrics.ts: in-process HTTP
// metrics in the Prometheus text format. Labels hold the matched route pattern, never the raw
// path, so ids and queries cannot blow up cardinality. Each process counts its own requests.
type Metrics struct {
	mu        sync.Mutex
	requests  map[requestSeries]int64
	durations map[durationSeries]*durations
	now       func() time.Time
	started   time.Time
}

// NewMetrics starts counting; now is the clock of the uptime.
func NewMetrics(now func() time.Time) *Metrics {
	return &Metrics{
		requests:  map[requestSeries]int64{},
		durations: map[durationSeries]*durations{},
		now:       now,
		started:   now(),
	}
}

// Observe records one finished request.
func (m *Metrics) Observe(method, route string, status int, seconds float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.requests[requestSeries{method, route, strconv.Itoa(status/100) + "xx"}]++
	key := durationSeries{method, route}
	series := m.durations[key]
	if series == nil {
		series = &durations{buckets: make([]int64, len(buckets))}
		m.durations[key] = series
	}
	series.count++
	series.sum += seconds
	for i, bound := range buckets {
		if seconds <= bound {
			series.buckets[i]++
		}
	}
}

var labelEscaper = strings.NewReplacer(`\`, `\\`, "\n", `\n`, `"`, `\"`)

// Render prints the exposition text. Series sort by label bytes: the order means nothing to a
// scraper, and it matches TypeScript's on the labels this API produces.
func (m *Metrics) Render() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var b bytes.Buffer
	b.WriteString("# HELP sipges_http_requests_total HTTP requests by method, route and status class.\n")
	b.WriteString("# TYPE sipges_http_requests_total counter\n")
	requests := make([]requestSeries, 0, len(m.requests))
	for key := range m.requests {
		requests = append(requests, key)
	}
	slices.SortFunc(requests, func(a, b requestSeries) int {
		return strings.Compare(a.method+"\x00"+a.route+"\x00"+a.status, b.method+"\x00"+b.route+"\x00"+b.status)
	})
	for _, key := range requests {
		fmt.Fprintf(&b, "sipges_http_requests_total{method=\"%s\",route=\"%s\",status=\"%s\"} %d\n",
			labelEscaper.Replace(key.method), labelEscaper.Replace(key.route), key.status, m.requests[key])
	}
	b.WriteString("# HELP sipges_http_request_duration_seconds HTTP request duration.\n")
	b.WriteString("# TYPE sipges_http_request_duration_seconds histogram\n")
	series := make([]durationSeries, 0, len(m.durations))
	for key := range m.durations {
		series = append(series, key)
	}
	slices.SortFunc(series, func(a, b durationSeries) int {
		return strings.Compare(a.method+"\x00"+a.route, b.method+"\x00"+b.route)
	})
	for _, key := range series {
		s := m.durations[key]
		labels := fmt.Sprintf(`method="%s",route="%s"`, labelEscaper.Replace(key.method), labelEscaper.Replace(key.route))
		for i, bound := range buckets {
			fmt.Fprintf(&b, "sipges_http_request_duration_seconds_bucket{%s,le=\"%s\"} %d\n",
				labels, strconv.FormatFloat(bound, 'f', -1, 64), s.buckets[i])
		}
		fmt.Fprintf(&b, "sipges_http_request_duration_seconds_bucket{%s,le=\"+Inf\"} %d\n", labels, s.count)
		fmt.Fprintf(&b, "sipges_http_request_duration_seconds_sum{%s} %s\n", labels, strconv.FormatFloat(s.sum, 'f', 6, 64))
		fmt.Fprintf(&b, "sipges_http_request_duration_seconds_count{%s} %d\n", labels, s.count)
	}
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	b.WriteString("# HELP sipges_process_uptime_seconds Seconds since the API started.\n")
	b.WriteString("# TYPE sipges_process_uptime_seconds gauge\n")
	fmt.Fprintf(&b, "sipges_process_uptime_seconds %s\n", strconv.FormatFloat(m.now().Sub(m.started).Seconds(), 'f', 3, 64))
	b.WriteString("# HELP sipges_process_resident_memory_bytes Resident set size.\n")
	b.WriteString("# TYPE sipges_process_resident_memory_bytes gauge\n")
	fmt.Fprintf(&b, "sipges_process_resident_memory_bytes %d\n", residentBytes(memory.Sys))
	b.WriteString("# HELP sipges_process_heap_used_bytes Go heap in use.\n")
	b.WriteString("# TYPE sipges_process_heap_used_bytes gauge\n")
	fmt.Fprintf(&b, "sipges_process_heap_used_bytes %d\n", memory.HeapAlloc)
	return b.String()
}

// residentBytes reads the resident set from /proc; where there is none, the memory the Go
// runtime obtained from the system stands in.
func residentBytes(fallback uint64) uint64 {
	statm, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return fallback
	}
	fields := bytes.Fields(statm)
	if len(fields) < 2 {
		return fallback
	}
	pages, err := strconv.ParseUint(string(fields[1]), 10, 64)
	if err != nil {
		return fallback
	}
	return pages * uint64(os.Getpagesize()) //nolint:gosec // a page size is positive
}

// metricMethods are the methods that get a label of their own. Go's server accepts any token,
// so a label per method would let anyone grow the series without a session.
var metricMethods = []string{
	http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut,
	http.MethodPatch, http.MethodDelete, http.MethodOptions,
}

func metricMethod(method string) string {
	if slices.Contains(metricMethods, method) {
		return method
	}
	return "OTHER"
}

// unmatchedRoute labels a request no route took, as routeOf does in observability.ts.
const unmatchedRoute = "unmatched"

// routeLabel turns a ServeMux pattern into the Hono one TypeScript labels with:
// "GET /api/{module}/{id}" becomes "/api/:module/:id"; the catch-all is unmatched.
func routeLabel(pattern string) string {
	if _, path, found := strings.Cut(pattern, " "); found {
		pattern = path
	}
	if pattern == "" || pattern == "/" {
		return unmatchedRoute
	}
	return strings.NewReplacer("{", ":", "}", "").Replace(pattern)
}

// ObserveRequests times every request. The route is resolved before the gates run, so a request
// they stop keeps its route's label, as in TypeScript.
func ObserveRequests(m *Metrics, route func(*http.Request) string) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			label := route(r)
			rec := &statusRecorder{ResponseWriter: w}
			next.ServeHTTP(rec, r)
			status := rec.status
			if status == 0 {
				status = http.StatusOK // a handler that wrote nothing
			}
			m.Observe(metricMethod(r.Method), label, status, time.Since(start).Seconds())
		})
	}
}

// metricsRoute is the Prometheus scrape endpoint of metrics.routes.ts; the role gate keeps it to
// administrators.
func metricsRoute(m *Metrics) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(m.Render()))
	}
}

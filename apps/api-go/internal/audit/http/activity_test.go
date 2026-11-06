package http

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/audit/application"
)

// fakeTrail serves scripted audit entries; entries become visible once their `from` has passed.
type fakeTrail struct {
	mu      sync.Mutex
	start   time.Time
	entries []timedEntry
	lastID  int64
	failAt  int // After fails on this call (1-based); 0 never
	afters  []int64
	limits  []int
}

type timedEntry struct {
	from time.Duration
	rec  application.Record
}

func (f *fakeTrail) Latest(*http.Request, int) ([]application.Record, error) { return nil, nil }

func (f *fakeTrail) LastID(*http.Request) (int64, error) { return f.lastID, nil }

func (f *fakeTrail) After(_ *http.Request, afterID int64, limit int) ([]application.Record, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.afters = append(f.afters, afterID)
	f.limits = append(f.limits, limit)
	if f.failAt == len(f.afters) {
		return nil, errors.New("synthetic failure")
	}
	out := []application.Record{}
	for _, e := range f.entries {
		if e.rec.ID > afterID && time.Since(f.start) >= e.from && len(out) < limit {
			out = append(out, e.rec)
		}
	}
	return out, nil
}

func (f *fakeTrail) firstAfter() int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.afters) == 0 {
		return -1
	}
	return f.afters[0]
}

func entry(id int64, module, action string) application.Record {
	secret := "D-SECRETA"
	return application.Record{ID: id, At: time.Unix(0, 0), Module: module, RecordID: &secret, Action: action, Detail: &secret}
}

// stream runs the activity handler behind a real server and returns the whole body.
func stream(t *testing.T, trail *fakeTrail, opts activityOptions, headers map[string]string, configure func(*http.Server)) (int, http.Header, string) {
	t.Helper()
	return streamWith(t, trail, accessFunc(func() (bool, error) { return true, nil }), opts, headers, configure)
}

type accessFunc func() (bool, error)

func (f accessFunc) StillAllowed(*http.Request) (bool, error) { return f() }

func streamWith(t *testing.T, trail *fakeTrail, access streamAccess, opts activityOptions, headers map[string]string, configure func(*http.Server)) (int, http.Header, string) {
	t.Helper()
	trail.start = time.Now()
	srv := httptest.NewUnstartedServer(activityHandler(trail, access, opts, slog.New(slog.DiscardHandler)))
	if configure != nil {
		configure(srv.Config)
	}
	srv.Start()
	t.Cleanup(srv.Close)
	r, err := http.NewRequestWithContext(t.Context(), http.MethodGet, srv.URL+ActivityPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read stream: %v (so far %q)", err, body)
	}
	return res.StatusCode, res.Header, string(body)
}

var fast = activityOptions{poll: 20 * time.Millisecond, max: 300 * time.Millisecond, heartbeat: time.Hour}

func TestActivityStreamsModuleAndActionOnlyFromTheNewestEntry(t *testing.T) {
	trail := &fakeTrail{lastID: 7, entries: []timedEntry{
		{0, entry(5, "Old", "CREATE")},
		{50 * time.Millisecond, entry(8, "Riesgos", "CREATE")},
		{50 * time.Millisecond, entry(9, "Eventos", "UPDATE")},
	}}
	status, header, body := stream(t, trail, fast, nil, nil)
	want := "event: ready\ndata: {}\nid: 7\n\n" +
		"event: activity\ndata: {\"module\":\"Riesgos\",\"action\":\"CREATE\"}\nid: 8\n\n" +
		"event: activity\ndata: {\"module\":\"Eventos\",\"action\":\"UPDATE\"}\nid: 9\n\n"
	if status != http.StatusOK || body != want {
		t.Fatalf("got %d %q, want %q", status, body, want)
	}
	for k, v := range map[string]string{"Content-Type": "text/event-stream", "Cache-Control": "no-cache"} {
		if got := header.Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	if strings.Contains(body, "D-SECRETA") {
		t.Error("the stream leaked a record id or detail")
	}
	if trail.firstAfter() != 7 || trail.limits[0] != 100 {
		t.Errorf("first poll after %d limit %d, want after 7 limit 100", trail.firstAfter(), trail.limits[0])
	}
}

func TestActivityResumesFromLastEventID(t *testing.T) {
	// Number(header): safe non-negative integers resume; anything else starts from the newest.
	cases := map[string]int64{
		"3": 3, "\t4\t": 4, "": 0, "1e1": 10, "0x10": 16, "0b11": 3, "0o7": 7, "5.0": 5, "-0": 0,
		"+6": 6, "9007199254740991": 9007199254740991,
		"abc": 42, "-1": 42, "1.5": 42, "9007199254740992": 42, "Infinity": 42, "1_0": 42, "-0x1": 42,
	}
	for header, want := range cases {
		trail := &fakeTrail{lastID: 42}
		_, _, body := stream(t, trail, activityOptions{poll: 10 * time.Millisecond, max: 20 * time.Millisecond, heartbeat: time.Hour},
			map[string]string{"Last-Event-ID": header}, nil)
		if got := trail.firstAfter(); got != want {
			t.Errorf("Last-Event-ID %q: resumed after %d, want %d", header, got, want)
		}
		if !strings.HasPrefix(body, "event: ready\ndata: {}\nid: ") {
			t.Errorf("Last-Event-ID %q: body %q", header, body)
		}
	}
}

func TestActivityChecksAccessBeforeEveryPoll(t *testing.T) {
	polls := 0
	trail := &fakeTrail{entries: []timedEntry{{0, entry(1, "Riesgos", "CREATE")}}}
	allowed := accessFunc(func() (bool, error) {
		polls++
		return polls == 1, nil // only the first poll may read
	})
	_, _, body := streamWith(t, trail, allowed, fast, map[string]string{"Last-Event-ID": "0"}, nil)
	want := "event: ready\ndata: {}\nid: 0\n\n" +
		"event: activity\ndata: {\"module\":\"Riesgos\",\"action\":\"CREATE\"}\nid: 1\n\n"
	if body != want || polls != 2 {
		t.Fatalf("after %d checks: %q", polls, body)
	}
}

func TestActivityEndsTheStreamWhenItsAccessCannotBeRead(t *testing.T) {
	trail := &fakeTrail{entries: []timedEntry{{0, entry(1, "Riesgos", "CREATE")}}}
	failing := accessFunc(func() (bool, error) { return false, errors.New("synthetic failure") })
	_, _, body := streamWith(t, trail, failing, fast, map[string]string{"Last-Event-ID": "0"}, nil)
	if body != "event: ready\ndata: {}\nid: 0\n\n" {
		t.Fatalf("got %q", body)
	}
}

func TestActivitySendsAHeartbeatWhenQuiet(t *testing.T) {
	trail := &fakeTrail{}
	_, _, body := stream(t, trail, activityOptions{poll: 20 * time.Millisecond, max: 150 * time.Millisecond, heartbeat: 40 * time.Millisecond}, nil, nil)
	if !strings.HasPrefix(body, "event: ready\ndata: {}\nid: 0\n\n: ping\n\n") || strings.Count(body, ": ping\n\n") < 2 {
		t.Fatalf("no heartbeat: %q", body)
	}
}

func TestActivityEndsTheStreamWhenAPollFails(t *testing.T) {
	trail := &fakeTrail{lastID: 1, failAt: 1}
	_, _, body := stream(t, trail, activityOptions{poll: 10 * time.Millisecond, max: time.Minute, heartbeat: time.Hour}, nil, nil)
	if body != "event: ready\ndata: {}\nid: 1\n\n" {
		t.Fatalf("got %q", body)
	}
}

func TestActivityOutlivesTheServerTimeouts(t *testing.T) {
	trail := &fakeTrail{entries: []timedEntry{{250 * time.Millisecond, entry(1, "Riesgos", "CREATE")}}}
	_, _, body := stream(t, trail, activityOptions{poll: 20 * time.Millisecond, max: 400 * time.Millisecond, heartbeat: time.Hour}, nil,
		func(s *http.Server) { s.ReadTimeout, s.WriteTimeout = 100*time.Millisecond, 100*time.Millisecond })
	if !strings.Contains(body, "event: activity\ndata: {\"module\":\"Riesgos\",\"action\":\"CREATE\"}\nid: 1\n\n") {
		t.Fatalf("the stream ended early: %q", body)
	}
}

func TestActivityDefaults(t *testing.T) {
	got := Deps{}.activityOptions()
	if got != (activityOptions{poll: 10 * time.Second, max: 240 * time.Second, heartbeat: 25 * time.Second}) {
		t.Fatalf("defaults %+v", got)
	}
	got = Deps{ActivityPoll: time.Second, ActivityMax: 2 * time.Second, ActivityHeartbeat: 3 * time.Second}.activityOptions()
	if got != (activityOptions{poll: time.Second, max: 2 * time.Second, heartbeat: 3 * time.Second}) {
		t.Fatalf("overrides %+v", got)
	}
}

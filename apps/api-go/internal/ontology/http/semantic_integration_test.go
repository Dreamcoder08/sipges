package http_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/app"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database/dbtest"
)

// embedderDouble gives a synthetic vector: 1 on the first axis for texts about a meeting. No real
// provider is ever contacted here.
type embedderDouble struct {
	mu   sync.Mutex
	sent []string
	raw  []string
	down bool
}

func (e *embedderDouble) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Input string `json:"input"`
	}
	raw, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(raw, &body)
	e.mu.Lock()
	defer e.mu.Unlock()
	e.sent = append(e.sent, body.Input)
	e.raw = append(e.raw, string(raw))
	if e.down {
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	vector := `[0,1,0,0,0,0,0,0.1]`
	if text := strings.ToLower(body.Input); strings.Contains(text, "reunión") || strings.Contains(text, "encuentro") {
		vector = `[1,0,0,0,0,0,0,0.1]`
	}
	_, _ = io.WriteString(w, `{"embeddings":[`+vector+`]}`)
}

func (e *embedderDouble) texts() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return strings.Join(e.sent, "\n")
}

func withEmbedder(t *testing.T) (*embedderDouble, string) {
	t.Helper()
	double := &embedderDouble{}
	srv := httptest.NewServer(double)
	t.Cleanup(srv.Close)
	t.Setenv("SIPGES_OLLAMA_URL", srv.URL)
	t.Setenv("SIPGES_OLLAMA_EMBED_MODEL", "fake-embed")
	t.Setenv("SIPGES_SEMANTIC_SEARCH", "1")
	base := start(t)
	t.Cleanup(func() { clearEmbeddings(t) })
	return double, base
}

func clearEmbeddings(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	if _, err := conn.Exec(ctx, `DELETE FROM record_embeddings`); err != nil {
		t.Fatal(err)
	}
}

type searchHit struct {
	ID       string          `json:"id"`
	Match    json.RawMessage `json:"match"`
	Semantic bool            `json:"semantic"`
}

func search(t *testing.T, base, q, user string) []searchHit {
	t.Helper()
	code, body := get(t, base, "/system/search?q="+q, user, nil)
	if code != http.StatusOK {
		t.Fatalf("%d %s", code, body)
	}
	var out struct {
		Hits []searchHit `json:"hits"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatal(err)
	}
	return out.Hits
}

func TestSemanticSearchFindsARecordByMeaning(t *testing.T) {
	double, base := withEmbedder(t)
	hits := search(t, base, "encuentro", "solo")
	if len(hits) != 1 || hits[0].ID != "E1" || !hits[0].Semantic || string(hits[0].Match) != "null" {
		t.Fatalf("hits = %+v", hits)
	}
	if !strings.Contains(double.texts(), "Reunión clave PROPIA") {
		t.Fatalf("sent %q", double.texts())
	}
}

func TestSemanticSearchFusesLexicalAndSemanticHits(t *testing.T) {
	_, base := withEmbedder(t)
	hits := search(t, base, "reuni%C3%B3n", "solo")
	if len(hits) != 1 || hits[0].ID != "E1" || !hits[0].Semantic || string(hits[0].Match) == "null" {
		t.Fatalf("hits = %+v", hits)
	}
}

func TestHalfAnEmojiInTheQueryReachesTheModelAsTypeScriptSendsIt(t *testing.T) {
	double, base := withEmbedder(t)
	// The route cuts q at 200 UTF-16 units, here in the middle of the emoji.
	search(t, base, strings.Repeat("x", 199)+"%F0%9F%98%80b", "solo")
	double.mu.Lock()
	defer double.mu.Unlock()
	last := double.raw[len(double.raw)-1]
	if !strings.HasSuffix(last, strings.Repeat("x", 199)+`\ud83d"}`) {
		t.Fatalf("body = %s", last)
	}
}

func TestRestrictedAndForeignRecordsNeverReachTheModel(t *testing.T) {
	double, base := withEmbedder(t)
	search(t, base, "encuentro", "solo")
	sent := double.texts()
	for _, leak := range []string{"Alerta clave", "AJENA"} {
		if strings.Contains(sent, leak) {
			t.Fatalf("%q reached the model: %q", leak, sent)
		}
	}
}

func TestTheIndexKeepsItsHashAndIsNotComputedTwice(t *testing.T) {
	double, base := withEmbedder(t)
	search(t, base, "encuentro", "solo")
	first := len(strings.Split(double.texts(), "\n"))
	search(t, base, "encuentro", "solo")
	if got := len(strings.Split(double.texts(), "\n")); got != first+1 {
		t.Fatalf("texts = %d, then %d", first, got)
	}
	ctx := t.Context()
	conn, err := pgx.Connect(ctx, scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	var stale, stored int
	err = conn.QueryRow(ctx, `SELECT count(*) FILTER (WHERE e.source_hash <> md5(r.payload::text)), count(*)
		FROM record_embeddings e JOIN module_records r USING (tenant_id, module, id)
		WHERE e.tenant_id = 'SIPGES/PRJ-SECHURA' AND e.model = 'fake-embed' AND cardinality(e.vector) = 8`).Scan(&stale, &stored)
	if err != nil {
		t.Fatal(err)
	}
	if stale != 0 || stored == 0 {
		t.Fatalf("stale %d of %d", stale, stored)
	}
}

func TestAReaderOnlySeesTheVectorsOfRecordsItMayRead(t *testing.T) {
	_, base := withEmbedder(t)
	search(t, base, "encuentro", "solo")
	for _, hit := range search(t, base, "alerta", "reader") {
		if hit.ID == "R1" {
			t.Fatalf("a read-only role found a restricted record: %+v", hit)
		}
	}
}

func TestTheModelDownLeavesTheLexicalResult(t *testing.T) {
	double, base := withEmbedder(t)
	double.down = true
	hits := search(t, base, "reuni%C3%B3n", "solo")
	if len(hits) != 1 || hits[0].ID != "E1" || hits[0].Semantic {
		t.Fatalf("hits = %+v", hits)
	}
	if hits := search(t, base, "encuentro", "solo"); len(hits) != 0 {
		t.Fatalf("hits = %+v", hits)
	}
}

func TestSearchIsLexicalUnlessSwitchedOn(t *testing.T) {
	double := &embedderDouble{}
	srv := httptest.NewServer(double)
	t.Cleanup(srv.Close)
	t.Setenv("SIPGES_OLLAMA_URL", srv.URL)
	base := start(t)
	if hits := search(t, base, "encuentro", "solo"); len(hits) != 0 {
		t.Fatalf("hits = %+v", hits)
	}
	if double.texts() != "" {
		t.Fatalf("sent %q", double.texts())
	}
}

func TestAnExternalModelIsNotContactedWhileTheSwitchIsOff(t *testing.T) {
	double := &embedderDouble{}
	// «localhost.» resolves to this machine, but it counts as external, as in TypeScript.
	srv := httptest.NewServer(double)
	t.Cleanup(srv.Close)
	t.Setenv("SIPGES_OLLAMA_URL", strings.Replace(srv.URL, "127.0.0.1", "localhost.", 1))
	t.Setenv("SIPGES_SEMANTIC_SEARCH", "1")
	base := start(t)
	began := time.Now()
	hits := search(t, base, "reuni%C3%B3n", "solo")
	if len(hits) != 1 || hits[0].Semantic || time.Since(began) > 5*time.Second {
		t.Fatalf("hits = %+v", hits)
	}
	if double.texts() != "" {
		t.Fatalf("sent %q", double.texts())
	}
}

// A slow model must not cut the search: the route outlives the server's write timeout.
func TestASlowModelDoesNotCutTheSearch(t *testing.T) {
	var calls atomic.Int32
	double := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		time.Sleep(150 * time.Millisecond)
		_, _ = io.WriteString(w, `{"embeddings":[[0,1,0,0,0,0,0,0.1]]}`)
	}))
	t.Cleanup(double.Close)
	t.Setenv("SIPGES_OLLAMA_URL", double.URL)
	t.Setenv("SIPGES_SEMANTIC_SEARCH", "1")
	t.Cleanup(func() { clearEmbeddings(t) })
	base := startWithWriteTimeout(t, 200*time.Millisecond)
	code, body := get(t, base, "/system/search?q=reuni%C3%B3n", "solo", nil)
	if code != http.StatusOK || !strings.Contains(body, `"hits"`) {
		t.Fatalf("%d %s", code, body)
	}
	if calls.Load() < 2 {
		t.Fatalf("calls = %d", calls.Load())
	}
}

func startWithWriteTimeout(t *testing.T, timeout time.Duration) string {
	t.Helper()
	if scratch == nil {
		t.Skip(dbtest.EnvAdminURL + " is not set")
	}
	pool, err := pgxpool.New(t.Context(), scratch.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	h, err := app.NewHandler(pool, app.Options{Logger: slog.New(slog.DiscardHandler), Now: func() time.Time { return t0 }})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewUnstartedServer(h)
	srv.Config.WriteTimeout = timeout
	srv.Start()
	t.Cleanup(srv.Close)
	return srv.URL
}

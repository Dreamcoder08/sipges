package http_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	recordshttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/http"
	tenancydomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// The answers of the TypeScript write routes on synthetic requests, recorded by
// ../testdata/writes.mjs through recordsRoutes and createRecordsService with an in-memory store:
// the Go routes and use cases, on a store that logs the same calls, must answer the same bytes
// and ask the store for the same writes (candidate ids, payload texts, lookups, import items,
// audit notes, timestamps).

type writeScenario struct {
	Name     string            `json:"name"`
	Method   string            `json:"method"`
	Path     string            `json:"path"`
	Body     *string           `json:"body"`
	Existing [][2]string       `json:"existing"`
	Company  string            `json:"company"`
	Project  string            `json:"project"`
	Status   int               `json:"status"`
	Response string            `json:"response"`
	Log      []json.RawMessage `json:"log"`
}

// memoryStore is the generator's memoryStore: application.Writer in memory, logging each call.
type memoryStore struct {
	rows map[string]bool
	log  []*domain.Object
}

func entry(pairs ...any) *domain.Object {
	o := domain.NewObject()
	for i := 0; i < len(pairs); i += 2 {
		o.Set(pairs[i].(string), pairs[i+1])
	}
	return o
}

func iso(at time.Time) string { return at.UTC().Format("2006-01-02T15:04:05.000Z") }

func key(module, id string) string { return module + "\x00" + id }

func (m *memoryStore) audit(module string, recordID any, note application.AuditNote, at time.Time) {
	m.log = append(m.log, entry("op", "audit", "module", module, "recordId", recordID, "action", note.Action, "detail", note.Detail, "at", iso(at)))
}

func (m *memoryStore) Create(_ context.Context, _, module string, candidates func(func(string) bool), payloadFor func(string) *domain.Object, note application.AuditNote, at time.Time) (string, error) {
	chosen := ""
	candidates(func(id string) bool {
		taken := m.rows[key(module, id)]
		m.log = append(m.log, entry("op", "insert", "module", module, "id", id, "payload", string(domain.Stringify(payloadFor(id))), "taken", taken, "at", iso(at)))
		if taken {
			return true
		}
		m.rows[key(module, id)] = true
		m.audit(module, id, note, at)
		chosen = id
		return false
	})
	return chosen, nil
}

func (m *memoryStore) Replace(_ context.Context, _, module, id string, payload *domain.Object, note application.AuditNote, at time.Time) (bool, error) {
	found := m.rows[key(module, id)]
	m.log = append(m.log, entry("op", "update", "module", module, "id", id, "payload", string(domain.Stringify(payload)), "found", found, "at", iso(at)))
	if found {
		m.audit(module, id, note, at)
	}
	return found, nil
}

func (m *memoryStore) Remove(_ context.Context, _, module, id string, note application.AuditNote, at time.Time) (bool, error) {
	found := m.rows[key(module, id)]
	delete(m.rows, key(module, id))
	m.log = append(m.log, entry("op", "delete", "module", module, "id", id, "found", found))
	if found {
		m.audit(module, id, note, at)
	}
	return found, nil
}

func (m *memoryStore) Existing(_ context.Context, _, module string, ids []string) (map[string]bool, error) {
	list := make([]any, len(ids))
	out := map[string]bool{}
	for i, id := range ids {
		list[i] = id
		if m.rows[key(module, id)] {
			out[id] = true
		}
	}
	m.log = append(m.log, entry("op", "existing", "module", module, "ids", list))
	return out, nil
}

func (m *memoryStore) ImportBatch(_ context.Context, _, module string, items []domain.ImportItem, note application.AuditNote, at time.Time) (int, int, error) {
	list := make([]any, len(items))
	created, updated := 0, 0
	for i, item := range items {
		list[i] = entry("id", item.ID, "payload", item.Payload)
		if m.rows[key(module, item.ID)] {
			updated++
		} else {
			m.rows[key(module, item.ID)] = true
			created++
		}
	}
	m.log = append(m.log, entry("op", "import", "module", module, "items", string(domain.Stringify(list)), "at", iso(at)))
	if created+updated > 0 {
		m.audit(module, nil, note, at)
	}
	return created, updated, nil
}

// countingHex is the generator's countingHex: 1, 2, 3, … left-padded with F.
func countingHex() domain.RandomHex {
	n := 0
	return func(length int) string {
		n++
		s := strings.ToUpper(fmt.Sprintf("%x", n))
		if len(s) < length {
			s = strings.Repeat("F", length-len(s)) + s
		}
		return s[len(s)-length:]
	}
}

// canonical reads a JSON text as JSON.parse does (lone surrogates kept) and writes it back as
// JSON.stringify does, so the recorded entries and Go's compare byte for byte.
func canonical(t *testing.T, raw []byte) string {
	t.Helper()
	v, err := domain.ParseBody(raw)
	if err != nil {
		t.Fatalf("log entry %s: %v", raw, err)
	}
	return string(domain.Stringify(v))
}

func TestWritesAnswerAsTypeScript(t *testing.T) {
	data, err := os.ReadFile("../testdata/writes.json")
	if err != nil {
		t.Fatal(err)
	}
	var recorded struct {
		At        string          `json:"at"`
		Scenarios []writeScenario `json:"scenarios"`
	}
	if err := json.Unmarshal(data, &recorded); err != nil {
		t.Fatal(err)
	}
	at, err := time.Parse(time.RFC3339Nano, recorded.At)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range recorded.Scenarios {
		t.Run(s.Name, func(t *testing.T) {
			store := &memoryStore{rows: map[string]bool{}}
			for _, e := range s.Existing {
				store.rows[key(e[0], e[1])] = true
			}
			mux := http.NewServeMux()
			recordshttp.RegisterWrites(mux, application.Writes{
				Store:     store,
				Now:       func() time.Time { return at.Add(456789 * time.Nanosecond) }, // truncated to ms
				RandomHex: countingHex(),
			}, nil)
			var body []byte
			if s.Body != nil {
				if body, err = base64.StdEncoding.DecodeString(*s.Body); err != nil {
					t.Fatal(err)
				}
			}
			r := httptest.NewRequest(s.Method, s.Path, bytes.NewReader(body))
			scope := tenancydomain.Scope{CompanyID: s.Company, ProjectID: s.Project}
			r = r.WithContext(tenancyhttp.WithScope(r.Context(), scope))
			w := httptest.NewRecorder()
			httpx.CanonicalPath()(mux).ServeHTTP(w, r)

			if w.Code != s.Status || w.Body.String() != s.Response {
				t.Errorf("answer\n got %d %s\nwant %d %s", w.Code, w.Body.String(), s.Status, s.Response)
			}
			if len(store.log) != len(s.Log) {
				t.Fatalf("store calls: got %d, want %d", len(store.log), len(s.Log))
			}
			for i, want := range s.Log {
				if got := string(domain.Stringify(store.log[i])); got != canonical(t, want) {
					t.Errorf("store call %d\n got %.400s\nwant %.400s", i, got, canonical(t, want))
				}
			}
		})
	}
}

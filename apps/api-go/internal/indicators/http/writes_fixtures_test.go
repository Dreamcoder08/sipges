package http_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/indicators/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/indicators/domain"
	indicatorshttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/indicators/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/engines"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// savedConfig and writtenSnapshot are what testdata/writes.json (recorded by
// testdata/generate.mjs from the TypeScript routes) says the SQL stores would write.
type savedConfig struct {
	Config string `json:"config"`
	At     string `json:"at"`
	Audit  string `json:"audit"`
}

type writtenSnapshot struct {
	TS            string  `json:"ts"`
	Irsa          float64 `json:"irsa"`
	Level         string  `json:"level"`
	Scores        string  `json:"scores"`
	ConfigVersion string  `json:"config_version"`
	Note          string  `json:"note"`
	Audit         string  `json:"audit"`
}

type fixtureCase struct {
	Name   string  `json:"name"`
	Path   string  `json:"path"`
	Stored *string `json:"stored"`
	Phase  *struct {
		ID      string `json:"id"`
		Weights string `json:"weights"`
	} `json:"phase"`
	Request  string           `json:"request"`
	Status   int              `json:"status"`
	Answer   int              `json:"answer"`
	Saved    *savedConfig     `json:"saved"`
	Snapshot *writtenSnapshot `json:"snapshot"`
}

func loadWritesFixture(t *testing.T) (time.Time, domain.Records, []string, []fixtureCase) {
	t.Helper()
	raw, err := os.ReadFile("../testdata/writes.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Now     time.Time                    `json:"now"`
		Records map[string][]json.RawMessage `json:"records"`
		Bodies  []string                     `json:"bodies"`
		Cases   []json.RawMessage            `json:"cases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	records := domain.Records{}
	for module, list := range f.Records {
		for _, payload := range list {
			var id struct {
				ID string `json:"_id"`
			}
			if err := json.Unmarshal(payload, &id); err != nil {
				t.Fatal(err)
			}
			records[module] = append(records[module], domain.Record{ID: id.ID, Payload: payload})
		}
	}
	cases := make([]fixtureCase, 0, len(f.Cases))
	for _, rawCase := range f.Cases {
		var c fixtureCase
		if err := json.Unmarshal(rawCase, &c); err != nil {
			t.Fatal(err)
		}
		cases = append(cases, c)
	}
	return f.Now, records, f.Bodies, cases
}

// memoryStore keeps one tenant's configuration and records what the routes write.
type memoryStore struct {
	config   json.RawMessage
	records  domain.Records
	phase    *domain.Phase
	saved    *savedConfig
	snapshot *writtenSnapshot
}

func (s *memoryStore) Config(context.Context, string) (json.RawMessage, error) { return s.config, nil }
func (s *memoryStore) Records(context.Context, string) (domain.Records, error) {
	return s.records, nil
}
func (s *memoryStore) IrsaInputs(context.Context, string) (application.IrsaInputs, error) {
	return application.IrsaInputs{Config: s.config, Records: s.records, Phase: s.phase}, nil
}
func (s *memoryStore) History(context.Context, string, *int64) ([]application.Snapshot, error) {
	return nil, nil
}
func (s *memoryStore) SaveConfig(_ context.Context, _ string, config json.RawMessage, at time.Time, audit string) error {
	s.saved = &savedConfig{Config: string(config), At: at.UTC().Format("2006-01-02T15:04:05.000Z"), Audit: audit}
	return nil
}
func (s *memoryStore) InsertSnapshot(_ context.Context, _ string, n application.NewSnapshot) (int64, error) {
	s.snapshot = &writtenSnapshot{
		TS: n.TS.UTC().Format("2006-01-02T15:04:05.000Z"), Irsa: n.Irsa, Level: n.Level,
		Scores: string(n.Scores), ConfigVersion: n.ConfigVersion, Note: n.Note, Audit: n.AuditDetail,
	}
	return 7, nil
}

// TestWritesAnswerAndStoreWhatTypeScriptDoes replays every recorded write through the Go routes
// and the embedded engine: same status, same answer bytes, same stored configuration bytes (key
// order included), same snapshot row and audit detail.
func TestWritesAnswerAndStoreWhatTypeScriptDoes(t *testing.T) {
	now, records, bodies, cases := loadWritesFixture(t)
	set, err := engines.Shared(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(cases) < 150 {
		t.Fatalf("only %d recorded cases", len(cases))
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			store := &memoryStore{records: records}
			if c.Stored != nil {
				store.config = json.RawMessage(*c.Stored)
			}
			if c.Phase != nil {
				p, ok := domain.ActivePhase(&c.Phase.ID, json.RawMessage(c.Phase.Weights))
				if !ok {
					t.Fatal("fixture phase is not active")
				}
				store.phase = &p
			}
			mux := http.NewServeMux()
			service := &application.Service{Store: store, Engine: set.Indicators, Now: func() time.Time { return now }}
			indicatorshttp.Routes(mux, service, nil)
			scope := tenancy.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-SECHURA"}
			r := httptest.NewRequestWithContext(tenancyhttp.WithScope(t.Context(), scope),
				http.MethodPost, c.Path, strings.NewReader(c.Request))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			got, _ := io.ReadAll(w.Result().Body)
			if w.Code != c.Status || string(got) != bodies[c.Answer] {
				t.Fatalf("got  %d %s\nwant %d %s", w.Code, got, c.Status, bodies[c.Answer])
			}
			if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
				t.Fatalf("content-type %q", ct)
			}
			if !equalPtr(store.saved, c.Saved) {
				t.Fatalf("saved  %+v\nwant   %+v", store.saved, c.Saved)
			}
			if !equalPtr(store.snapshot, c.Snapshot) {
				t.Fatalf("snapshot %+v\nwant     %+v", store.snapshot, c.Snapshot)
			}
		})
	}
}

func equalPtr[T comparable](a, b *T) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

package application

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// The answers and saves of the TypeScript PUT /system/v4/settings on synthetic requests, recorded
// by ../testdata/settings.mjs: the issues must match byte for byte, the answer as JSON values,
// and the settings text, audit detail, author and time the store receives exactly.

type savedSettings struct {
	Settings  string `json:"settings"`
	UpdatedBy string `json:"updatedBy"`
	UpdatedAt string `json:"updatedAt"`
	Detail    string `json:"detail"`
}

type settingsStore struct {
	Store
	row   *domain.Row
	saved *savedSettings
}

func (s *settingsStore) SettingsForUpdate(context.Context, database.Querier, string) (*domain.Row, error) {
	return s.row, nil
}

func (s *settingsStore) SaveSettings(_ context.Context, _ database.Querier, _ string, settings []byte, by string, at time.Time, detail string) error {
	s.saved = &savedSettings{string(settings), by, isoMillis(at), detail}
	return nil
}

func TestSettingsUpdateMatchesTheRecordedTypeScript(t *testing.T) {
	raw, err := os.ReadFile("../testdata/settings.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		At        time.Time `json:"at"`
		Before    time.Time `json:"before"`
		Scenarios []struct {
			Name     string         `json:"name"`
			Stored   *string        `json:"stored"`
			Body     string         `json:"body"`
			Status   int            `json:"status"`
			Response string         `json:"response"`
			Saved    *savedSettings `json:"saved"`
		} `json:"scenarios"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Scenarios) == 0 {
		t.Fatal("no scenarios")
	}
	for _, s := range file.Scenarios {
		t.Run(s.Name, func(t *testing.T) {
			body, err := records.ParseBody([]byte(s.Body))
			var patch domain.SettingsPatch
			issues := records.JSONInvalid
			if err == nil {
				patch, issues = domain.ParseSettingsPatch(body)
			}
			if s.Status == 422 {
				if got := string(records.AppendIssues(nil, issues)); got != s.Response {
					t.Fatalf("issues\n got %s\nwant %s", got, s.Response)
				}
				return
			}
			if issues != nil {
				t.Fatalf("refused: %v", issues)
			}
			store := &settingsStore{}
			if s.Stored != nil {
				o, err := records.ParseObject([]byte(*s.Stored))
				if err != nil {
					t.Fatal(err)
				}
				store.row = &domain.Row{Settings: o, UpdatedBy: "antes", UpdatedAt: file.Before}
			}
			answer, err := UpdateSettings(context.Background(), nil, store, "SIPGES/PRJ-SINT", patch, "sint.admin", file.At)
			if err != nil {
				t.Fatal(err)
			}
			got, err := json.Marshal(answer)
			if err != nil {
				t.Fatal(err)
			}
			var gotJSON, wantJSON any
			if err := json.Unmarshal(got, &gotJSON); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(s.Response), &wantJSON); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(gotJSON, wantJSON) {
				t.Fatalf("answer\n got %s\nwant %s", got, s.Response)
			}
			if !reflect.DeepEqual(store.saved, s.Saved) {
				t.Fatalf("saved\n got %+v\nwant %+v", store.saved, s.Saved)
			}
			if s.Saved != nil && strings.Contains(s.Saved.Settings, "version4") {
				t.Fatal("the version4 key must not be carried into a save")
			}
		})
	}
}

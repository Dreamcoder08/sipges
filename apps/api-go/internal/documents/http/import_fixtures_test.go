package http

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancydomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// recordingReviews keeps the rows ImportItems receives; nothing else is called on import.
type recordingReviews struct {
	application.ReviewWriter
	imported []map[string]any
}

func (s *recordingReviews) ImportItems(_ context.Context, tenantID string, rows []application.NewReviewItem) (int, error) {
	list := make([]any, len(rows))
	for i, r := range rows {
		list[i] = map[string]any{
			"id": r.ID, "projectId": r.ProjectID, "sourceFile": r.SourceFile, "sourceSha256": r.SourceSHA256,
			"location": r.Location, "theme": r.Theme, "excerpt": r.Excerpt, "action": r.Action,
			"createdAt": r.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		}
	}
	s.imported = append(s.imported, map[string]any{"tenantId": tenantID, "rows": list})
	return len(rows), nil
}

// TestImportReadsItemsAsTheTypeScriptLab sends the recorded batches through the route and the
// real use case: every item's text (Python str() of any JSON value, cut to its code point
// limit), the skipped items, the NUL refusal and the answer.
func TestImportReadsItemsAsTheTypeScriptLab(t *testing.T) {
	raw, err := os.ReadFile("../testdata/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Now     time.Time `json:"now"`
		Imports []struct {
			Body     string           `json:"body"`
			Status   int              `json:"status"`
			Response json.RawMessage  `json:"response"`
			Rows     []map[string]any `json:"rows"`
		} `json:"imports"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	for i, c := range f.Imports {
		store := &recordingReviews{imported: []map[string]any{}}
		n := 0
		mux := http.NewServeMux()
		LabRoutes(mux, LabService{application.Lab{
			Reviews: store,
			Now:     func() time.Time { return f.Now },
			RandomHex: func(length int) (string, error) {
				s := strings.ToUpper(strconv.FormatInt(int64(n), 16))
				n++
				return strings.Repeat("0", length-len(s)) + s, nil
			},
			MaxUploadBytes: 1000,
		}}, nil)
		r := httptest.NewRequest(http.MethodPost, "/system/document-lab/review/import", strings.NewReader(c.Body))
		r = r.WithContext(tenancyhttp.WithScope(r.Context(), tenancydomain.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-SECHURA"}))
		w := httptest.NewRecorder()
		httpx.CanonicalPath()(mux).ServeHTTP(w, r)
		if w.Code != c.Status || !reflect.DeepEqual(jsonValue(t, w.Body.Bytes()), jsonValue(t, c.Response)) {
			t.Errorf("batch %d: %d %s, TypeScript %d %s", i, w.Code, w.Body.String(), c.Status, c.Response)
		}
		got, _ := json.Marshal(store.imported)
		want, _ := json.Marshal(c.Rows)
		if !reflect.DeepEqual(jsonValue(t, got), jsonValue(t, want)) {
			t.Errorf("batch %d rows:\n got %.900s\nwant %.900s", i, got, want)
		}
	}
}

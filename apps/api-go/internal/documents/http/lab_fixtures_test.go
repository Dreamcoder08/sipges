package http

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/domain"
	identitydomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/domain"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancydomain "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// httpFixture is the http section of testdata/fixtures.json: raw requests to
// documentLabRoutes with a fake service, the answers and the calls the fake received.
type httpFixture struct {
	MaxUploadBytes int `json:"max_upload_bytes"`
	HTTP           []struct {
		Name        string            `json:"name"`
		Method      string            `json:"method"`
		Path        string            `json:"path"`
		ContentType *string           `json:"content_type"`
		Headers     map[string]string `json:"headers"`
		Body        [][2]any          `json:"body"`
		Status      int               `json:"status"`
		Response    json.RawMessage   `json:"response"`
		Disposition *string           `json:"disposition"`
		Calls       []map[string]any  `json:"calls"`
	} `json:"http"`
}

// fakeLab answers as the fake service of generate.mjs and records its calls the same way.
type fakeLab struct {
	limit int
	calls []map[string]any
}

var (
	fileKind   = regexp.MustCompile(`^err-([a-z_]+)\.`)
	importKind = regexp.MustCompile(`^err-([a-z_0-9]+)$`)
	textKind   = regexp.MustCompile(`^err-([a-z_]+)$`)
)

func kind(re *regexp.Regexp, s string) string {
	if m := re.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return ""
}

func fileCall(f application.DocumentFile) map[string]any {
	if len(f.Data) > 512 {
		sum := sha256.Sum256(f.Data)
		return map[string]any{"fileName": f.FileName, "sha256": hex.EncodeToString(sum[:]), "length": float64(len(f.Data))}
	}
	return map[string]any{"fileName": f.FileName, "data": base64.StdEncoding.EncodeToString(f.Data)}
}

func (l *fakeLab) UploadLimit() int { return l.limit }
func (l *fakeLab) ReportContentType() string {
	return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
}

func (l *fakeLab) Analyze(_ context.Context, f application.DocumentFile, project string) (domain.DocumentAnalysis, application.ReadError) {
	l.calls = append(l.calls, map[string]any{"op": "analyze", "file": fileCall(f), "projectId": project})
	return domain.DocumentAnalysis{}, application.ReadError(kind(fileKind, f.FileName))
}

func (l *fakeLab) Report(_ context.Context, f application.DocumentFile, project string) ([]byte, application.ReadError, error) {
	l.calls = append(l.calls, map[string]any{"op": "report", "file": fileCall(f), "projectId": project})
	return []byte("DOCX"), application.ReadError(kind(fileKind, f.FileName)), nil
}

func (l *fakeLab) Compare(_ context.Context, a, b application.DocumentFile, project string) (application.Comparison, application.ReadError) {
	l.calls = append(l.calls, map[string]any{"op": "compare", "a": fileCall(a), "b": fileCall(b), "projectId": project})
	k := kind(fileKind, a.FileName)
	if k == "" {
		k = kind(fileKind, b.FileName)
	}
	return application.Comparison{}, application.ReadError(k)
}

func (l *fakeLab) ImportReview(_ context.Context, tenantID string, batch application.ReviewBatch) (int, application.ImportError, error) {
	l.calls = append(l.calls, map[string]any{"op": "import", "tenantId": tenantID, "batch": map[string]any{
		"projectId": batch.ProjectID, "filename": batch.Filename, "sha256": batch.SHA256, "items": float64(len(batch.Items)),
	}})
	return 3, application.ImportError(kind(importKind, batch.Filename)), nil
}

func (l *fakeLab) Decide(_ context.Context, tenantID, id, status, reviewer, note string) (application.DecisionResult, domain.DecisionError, error) {
	l.calls = append(l.calls, map[string]any{"op": "decide", "tenantId": tenantID, "input": map[string]any{
		"id": id, "status": status, "reviewer": reviewer, "note": note,
	}})
	return application.DecisionResult{ID: id, Status: status}, domain.DecisionError(kind(textKind, id)), nil
}

func (l *fakeLab) DecideMany(_ context.Context, tenantID string, in application.BulkInput) (application.BulkDecision, domain.DecisionError, error) {
	var ids any
	if in.IDs != nil {
		list := make([]any, len(in.IDs))
		for i, id := range in.IDs {
			list[i] = id
		}
		ids = list
	}
	opt := func(s *string) any {
		if s == nil {
			return nil
		}
		return *s
	}
	l.calls = append(l.calls, map[string]any{"op": "bulk", "tenantId": tenantID, "input": map[string]any{
		"projectId": in.ProjectID, "ids": ids, "theme": opt(in.Theme), "sourceSha256": opt(in.SourceSHA256),
		"status": in.Status, "reviewer": in.Reviewer, "note": in.Note, "dryRun": in.DryRun,
	}})
	return application.BulkDecision{
		Decided: 2, RecordsCreated: 1, Remaining: 4,
		Modules:  []application.BulkModule{{Module: "hechos", Label: "Hechos compartidos", Nuevos: 1, YaExistentes: 1}},
		Problems: []string{},
	}, domain.DecisionError(kind(textKind, in.Note)), nil
}

// comparable turns a recorded import call into the fields the Go fake sees: the items' text is
// pinned by TestImportReadsItemsAsTheTypeScriptLab, only their number here.
func comparable(call map[string]any) map[string]any {
	if call["op"] == "import" {
		batch := call["batch"].(map[string]any)
		batch["items"] = float64(len(batch["items"].([]any)))
	}
	return call
}

func jsonValue(t *testing.T, raw []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("%v: %s", err, raw)
	}
	return v
}

func TestLabRoutesAnswerAsTheTypeScriptRoutes(t *testing.T) {
	raw, err := os.ReadFile("../testdata/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var f httpFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.HTTP) < 150 {
		t.Fatalf("only %d recorded requests", len(f.HTTP))
	}
	for _, c := range f.HTTP {
		var body strings.Builder
		for _, seg := range c.Body {
			body.WriteString(strings.Repeat(seg[0].(string), int(seg[1].(float64))))
		}
		lab := &fakeLab{limit: f.MaxUploadBytes}
		mux := http.NewServeMux()
		LabRoutes(mux, lab, nil)
		r := httptest.NewRequest(c.Method, c.Path, strings.NewReader(body.String()))
		if c.ContentType != nil {
			r.Header.Set("Content-Type", *c.ContentType)
		}
		fullName := "Analista Sintética"
		if v, ok := c.Headers["x-test-full-name"]; ok {
			fullName = v
		}
		ctx := tenancyhttp.WithScope(r.Context(), tenancydomain.Scope{CompanyID: "SIPGES", ProjectID: "PRJ-SECHURA"})
		ctx = identityhttp.WithPrincipal(ctx, &identitydomain.Principal{Username: "analista.sintetica", FullName: fullName})
		w := httptest.NewRecorder()
		httpx.CanonicalPath()(mux).ServeHTTP(w, r.WithContext(ctx))

		if w.Code != c.Status {
			t.Errorf("%s: status %d, TypeScript %d (%s)", c.Name, w.Code, c.Status, w.Body.String())
			continue
		}
		success := c.Status == http.StatusOK
		switch {
		case success && strings.HasSuffix(c.Path, "/report.docx"):
			if w.Body.String() != "DOCX" || c.Disposition == nil || w.Header().Get("Content-Disposition") != *c.Disposition {
				t.Errorf("%s: report answer %q %q", c.Name, w.Body.String(), w.Header().Get("Content-Disposition"))
			}
		case success && (strings.HasSuffix(c.Path, "/analyze") || strings.HasSuffix(c.Path, "/compare")):
			// The fake's own value; the real answers are pinned by the application tests.
		default:
			if got, want := jsonValue(t, w.Body.Bytes()), jsonValue(t, c.Response); !reflect.DeepEqual(got, want) {
				t.Errorf("%s:\n got %s\nwant %s", c.Name, w.Body.String(), c.Response)
			}
		}
		want := make([]any, len(c.Calls))
		for i, call := range c.Calls {
			want[i] = comparable(call)
		}
		got := make([]any, len(lab.calls))
		for i, call := range lab.calls {
			b, _ := json.Marshal(call)
			got[i] = jsonValue(t, b)
		}
		if !reflect.DeepEqual(got, want) {
			gb, _ := json.Marshal(got)
			wb, _ := json.Marshal(want)
			t.Errorf("%s: calls\n got %.600s\nwant %.600s", c.Name, gb, wb)
		}
	}
}

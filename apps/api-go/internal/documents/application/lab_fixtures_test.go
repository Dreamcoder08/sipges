package application_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"regexp"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/infrastructure"
)

// labFixture is testdata/fixtures.json, recorded from the TypeScript document lab
// (testdata/generate.mjs).
type labFixture struct {
	Now      time.Time `json:"now"`
	Analyses []struct {
		Name   string          `json:"name"`
		Data   string          `json:"data"`
		Result json.RawMessage `json:"result"`
	} `json:"analyses"`
	Comparisons []struct {
		A      int             `json:"a"`
		B      int             `json:"b"`
		Result json.RawMessage `json:"result"`
	} `json:"comparisons"`
	ReportParts [][2]*string `json:"report_parts"`
	Reports     []struct {
		Name  string      `json:"name"`
		Data  string      `json:"data"`
		Parts [][2]string `json:"parts"`
	} `json:"reports"`
	Records []struct {
		Item struct {
			ID           string    `json:"id"`
			ProjectID    string    `json:"projectId"`
			SourceFile   string    `json:"sourceFile"`
			SourceSHA256 string    `json:"sourceSha256"`
			Location     string    `json:"location"`
			Theme        string    `json:"theme"`
			Excerpt      string    `json:"excerpt"`
			Action       string    `json:"action"`
			Status       string    `json:"status"`
			Reviewer     string    `json:"reviewer"`
			Note         string    `json:"note"`
			CreatedAt    time.Time `json:"createdAt"`
			UpdatedAt    time.Time `json:"updatedAt"`
		} `json:"item"`
		Fields [][2]string `json:"fields"`
	} `json:"records"`
}

func loadFixture(t *testing.T) labFixture {
	t.Helper()
	raw, err := os.ReadFile("../testdata/fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var f labFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func newLab(now time.Time) application.Lab {
	return application.Lab{
		Reader:         infrastructure.Reader{},
		Renderer:       infrastructure.DocxRenderer{},
		Now:            func() time.Time { return now },
		MaxUploadBytes: 1024 * 1024,
	}
}

// result is the fixture's {"value": …} or {"error": kind}.
func result(t *testing.T, value any, refused string) []byte {
	t.Helper()
	if refused != "" {
		b, _ := json.Marshal(map[string]string{"error": refused})
		return b
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(map[string]any{"value": value}); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func sameJSON(t *testing.T, name string, got, want []byte) {
	t.Helper()
	var g, w bytes.Buffer
	if err := json.Compact(&g, got); err != nil {
		t.Fatal(err)
	}
	if err := json.Compact(&w, want); err != nil {
		t.Fatal(err)
	}
	if g.String() != w.String() {
		t.Errorf("%s:\n got %s\nwant %s", name, g.String(), w.String())
	}
}

func file(t *testing.T, name, data string) application.DocumentFile {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		t.Fatal(err)
	}
	return application.DocumentFile{FileName: name, Data: b}
}

func TestAnalyzeAnswersAsTheTypeScriptLab(t *testing.T) {
	f := loadFixture(t)
	lab := newLab(f.Now)
	if len(f.Analyses) < 25 {
		t.Fatalf("only %d recorded analyses", len(f.Analyses))
	}
	for _, a := range f.Analyses {
		got, refused := lab.Analyze(context.Background(), file(t, a.Name, a.Data), "PRJ-SECHURA")
		sameJSON(t, a.Name, result(t, got, string(refused)), a.Result)
	}
}

func TestCompareAnswersAsTheTypeScriptLab(t *testing.T) {
	f := loadFixture(t)
	lab := newLab(f.Now)
	for _, c := range f.Comparisons {
		a, b := f.Analyses[c.A], f.Analyses[c.B]
		got, refused := lab.Compare(context.Background(), file(t, a.Name, a.Data), file(t, b.Name, b.Data), "PRJ-SECHURA")
		sameJSON(t, a.Name+" × "+b.Name, result(t, got, string(refused)), c.Result)
	}
}

var coreDates = regexp.MustCompile(`(<dcterms:(?:created|modified) xsi:type="dcterms:W3CDTF">)[^<]*`)

// TestReportIsTheTypeScriptPackage compares the Word report part by part: the same part names
// in the same order, every part byte-identical to docx's output once the two dates of
// docProps/core.xml are replaced. Only the zip container (entry dates, deflate output) differs.
func TestReportIsTheTypeScriptPackage(t *testing.T) {
	f := loadFixture(t)
	lab := newLab(f.Now)
	for _, r := range f.Reports {
		out, refused, err := lab.Report(context.Background(), file(t, r.Name, r.Data), "PRJ-SECHURA")
		if err != nil || refused != "" {
			t.Fatalf("%s: %v %s", r.Name, err, refused)
		}
		zr, err := zip.NewReader(bytes.NewReader(out), int64(len(out)))
		if err != nil {
			t.Fatal(err)
		}
		varying := map[string]string{}
		for _, p := range r.Parts {
			varying[p[0]] = p[1]
		}
		if len(zr.File) != len(f.ReportParts) {
			t.Fatalf("%s: %d parts, TypeScript %d", r.Name, len(zr.File), len(f.ReportParts))
		}
		for i, zf := range zr.File {
			name := *f.ReportParts[i][0]
			if zf.Name != name {
				t.Errorf("%s: part %d is %s, TypeScript %s", r.Name, i, zf.Name, name)
				continue
			}
			rc, err := zf.Open()
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(rc)
			_ = rc.Close()
			if err != nil {
				t.Fatal(err)
			}
			want := varying[name]
			if fixed := f.ReportParts[i][1]; fixed != nil {
				want = *fixed
			}
			if got := coreDates.ReplaceAllString(string(data), "${1}DATE"); got != want {
				t.Errorf("%s: %s differs:\n got %s\nwant %s", r.Name, name, got, want)
			}
		}
	}
}

func TestReviewRecordFieldsAreTheTypeScriptFields(t *testing.T) {
	f := loadFixture(t)
	for _, r := range f.Records {
		it := r.Item
		got := domain.ReviewRecordFields(domain.ReviewItem{
			ID: it.ID, ProjectID: it.ProjectID, SourceFile: it.SourceFile, SourceSHA256: it.SourceSHA256,
			Location: it.Location, Theme: it.Theme, Excerpt: it.Excerpt, Action: it.Action, Status: it.Status,
			Reviewer: it.Reviewer, Note: it.Note, CreatedAt: it.CreatedAt, UpdatedAt: it.UpdatedAt,
		}, "PRJ-SECHURA")
		pairs := make([][2]string, len(got))
		for i, field := range got {
			pairs[i] = [2]string{field.Key, field.Value}
		}
		g, _ := json.Marshal(pairs)
		w, _ := json.Marshal(r.Fields)
		sameJSON(t, it.Theme+"/"+it.Status, g, w)
	}
}

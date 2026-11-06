package http_test

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/domain"
	documentshttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/http"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// slowReader takes longer than the server's WriteTimeout, as OCR does.
type slowReader struct{}

func (slowReader) ReadPDF(context.Context, []byte, int) ([]string, bool, error) {
	time.Sleep(300 * time.Millisecond)
	return []string{"La asamblea de la comunidad aprobó el acuerdo de seguimiento."}, false, nil
}

func (slowReader) ReadDOCX(context.Context, []byte) (domain.DocxContent, error) {
	return domain.DocxContent{}, nil
}

func TestASlowReadReachesTheClientPastTheServerWriteTimeout(t *testing.T) {
	mux := http.NewServeMux()
	lab := application.Lab{Reader: slowReader{}, Now: time.Now, MaxUploadBytes: 1 << 20}
	documentshttp.LabRoutes(mux, documentshttp.LabService{Lab: lab}, nil)
	scoped := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.ServeHTTP(w, r.WithContext(tenancyhttp.WithScope(r.Context(), tenancy.Scope{ProjectID: "P"})))
	})
	server := httptest.NewUnstartedServer(scoped)
	server.Config.WriteTimeout = 100 * time.Millisecond
	server.Start()
	defer server.Close()

	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("file", "acta.pdf")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("%PDF-1.7"))
	_ = form.Close()
	res, err := http.Post(server.URL+"/system/document-lab/analyze", form.FormDataContentType(), &body)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	got, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK || !strings.Contains(string(got), "Página 1") {
		t.Fatalf("%d %s", res.StatusCode, got)
	}
}

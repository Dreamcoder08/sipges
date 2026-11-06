package infrastructure

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/domain"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile("../../platform/doctext/testdata/pdf/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestReaderReadsThePagesOfAPDF(t *testing.T) {
	pages, tooMany, err := Reader{}.ReadPDF(t.Context(), fixture(t, "05-two-columns.pdf"), domain.MaxPDFPages)
	if err != nil || tooMany || len(pages) != 2 || strings.TrimSpace(pages[0]) == "" {
		t.Fatalf("pages=%d tooMany=%v err=%v", len(pages), tooMany, err)
	}
}

func TestReaderAnswersTooManyPages(t *testing.T) {
	_, tooMany, err := Reader{}.ReadPDF(t.Context(), fixture(t, "71-large-101-pages.pdf"), domain.MaxPDFPages)
	if err != nil || !tooMany {
		t.Fatalf("tooMany=%v err=%v", tooMany, err)
	}
}

func TestReaderBoundsAPDFByItsTimeout(t *testing.T) {
	reader := Reader{Timeout: 100 * time.Millisecond}
	if _, _, err := reader.ReadPDF(t.Context(), fixture(t, "71-large-101-pages.pdf"), 200); err == nil {
		t.Fatal("a read past its timeout must fail")
	}
}

// The chain of the lab routes: the scanned file has pages without text (no_text, 422), the broken
// one is unreadable (422), and neither reaches a 501.
func TestLabAnswersOfRealPDFs(t *testing.T) {
	lab := application.Lab{Reader: Reader{}, Now: time.Now, MaxUploadBytes: 1 << 24}
	ctx := context.Background()
	if _, refused := lab.Analyze(ctx, application.DocumentFile{FileName: "a.pdf", Data: fixture(t, "30-scanned-image-only.pdf")}, "P"); refused != application.ReadNoText {
		t.Fatalf("scanned: %q", refused)
	}
	if _, refused := lab.Analyze(ctx, application.DocumentFile{FileName: "a.pdf", Data: fixture(t, "62-bad-truncated-half.pdf")}, "P"); refused != application.ReadUnreadable {
		t.Fatalf("broken: %q", refused)
	}
	got, refused := lab.Analyze(ctx, application.DocumentFile{FileName: "a.pdf", Data: fixture(t, "01-plain-helvetica.pdf")}, "P")
	if refused != "" || len(got.Items) == 0 || got.Items[0].Ubicacion != "Página 1" {
		t.Fatalf("refused=%q items=%d", refused, len(got.Items))
	}
}

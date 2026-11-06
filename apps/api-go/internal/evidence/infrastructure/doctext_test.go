package infrastructure

import (
	"os"
	"strings"
	"testing"
)

func TestDocTextReadsAPDFForThePreview(t *testing.T) {
	data, err := os.ReadFile("../../platform/doctext/testdata/pdf/01-plain-helvetica.pdf")
	if err != nil {
		t.Fatal(err)
	}
	pages, tooLong, err := DocText{}.PDF(t.Context(), data, 20)
	if err != nil || tooLong || len(pages) != 1 || !strings.Contains(pages[0], "Acta de reunión") {
		t.Fatalf("pages=%q tooLong=%v err=%v", pages, tooLong, err)
	}
}

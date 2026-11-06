package infrastructure

import (
	"context"
	"strings"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/doctext"
)

// previewParseTimeout bounds one read, as the TypeScript PDF worker pool bounds a PDF.
const previewParseTimeout = 30 * time.Second

// DocText is the viewer's text reader of compose.ts, with the document lab's readers
// (platform/doctext): PDF pages, and DOCX paragraphs and then each table row's cells joined by tabs.
type DocText struct {
	// OCR reads PDFs without a text layer; nil keeps text-only reading.
	OCR *doctext.OCR
}

var _ application.TextExtractor = DocText{}

// PDF is the viewer's `pdf` text function of compose.ts.
func (d DocText) PDF(ctx context.Context, data []byte, maxPages int) ([]string, bool, error) {
	return d.OCR.ReadPDF(ctx, data, maxPages, previewParseTimeout)
}

// DOCX is the viewer's `docx` text function of compose.ts.
func (DocText) DOCX(ctx context.Context, data []byte) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, previewParseTimeout)
	defer cancel()
	c, err := doctext.ReadDOCX(ctx, data)
	if err != nil {
		return nil, err
	}
	out := append([]string{}, c.Paragraphs...)
	for _, rows := range c.Tables {
		for _, row := range rows {
			out = append(out, strings.Join(row, "\t"))
		}
	}
	return out, nil
}

package infrastructure

import (
	"context"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/doctext"
)

// ParseTimeout bounds one document's parsing, as the PDF worker pool of the TypeScript API
// bounds a PDF (30 s); a parse past it is an unreadable document.
const ParseTimeout = 30 * time.Second

// Reader is the document lab's DocumentReader: DOCX through doctext (the TypeScript reader,
// ported) and PDF with pdf.js itself, in WebAssembly, because its text items (spacing, line ends,
// ordering) are what the lexical reading splits into findings (ADR 0033).
type Reader struct {
	// Timeout overrides ParseTimeout when positive.
	Timeout time.Duration
	// OCR reads PDFs without a text layer; nil keeps text-only reading.
	OCR *doctext.OCR
}

var _ application.DocumentReader = Reader{}

func (r Reader) timeout() time.Duration {
	if r.Timeout > 0 {
		return r.Timeout
	}
	return ParseTimeout
}

// ReadPDF is readPdf with the fallback of withOcr.
func (r Reader) ReadPDF(ctx context.Context, data []byte, maxPages int) ([]string, bool, error) {
	return r.OCR.ReadPDF(ctx, data, maxPages, r.timeout())
}

// ReadDOCX is readDocx.
func (r Reader) ReadDOCX(ctx context.Context, data []byte) (domain.DocxContent, error) {
	ctx, cancel := context.WithTimeout(ctx, r.timeout())
	defer cancel()
	c, err := doctext.ReadDOCX(ctx, data)
	if err != nil {
		return domain.DocxContent{}, err
	}
	return domain.DocxContent{Paragraphs: c.Paragraphs, Tables: c.Tables}, nil
}

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
// ported), and no PDF. pdf.js's text items (spacing, line ends, ordering) are what the lexical
// reading splits into findings, and no Go or Rust library reproduces them, so a PDF answers
// application.ErrPDFUnsupported and the routes that read PDFs stay in TypeScript.
type Reader struct {
	// Timeout overrides ParseTimeout when positive.
	Timeout time.Duration
}

var _ application.DocumentReader = Reader{}

func (r Reader) bound(ctx context.Context) (context.Context, context.CancelFunc) {
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = ParseTimeout
	}
	return context.WithTimeout(ctx, timeout)
}

// ReadPDF is not ported (see Reader).
func (Reader) ReadPDF(context.Context, []byte, int) ([]string, bool, error) {
	return nil, false, application.ErrPDFUnsupported
}

// ReadDOCX is readDocx.
func (r Reader) ReadDOCX(ctx context.Context, data []byte) (domain.DocxContent, error) {
	ctx, cancel := r.bound(ctx)
	defer cancel()
	c, err := doctext.ReadDOCX(ctx, data)
	if err != nil {
		return domain.DocxContent{}, err
	}
	return domain.DocxContent{Paragraphs: c.Paragraphs, Tables: c.Tables}, nil
}

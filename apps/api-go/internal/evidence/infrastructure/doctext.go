package infrastructure

import (
	"context"
	"strings"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/doctext"
)

// previewParseTimeout bounds one DOCX read, as the TypeScript PDF worker pool bounds a PDF.
const previewParseTimeout = 30 * time.Second

// DocText is the viewer's text reader of compose.ts: DOCX with the document lab's reader
// (platform/doctext), its paragraphs and then each table row's cells joined by tabs. PDF text
// comes from pdf.js, which no Go library reproduces, so a PDF answers
// application.ErrNoTextExtractor (the route's 501) and its preview stays in TypeScript.
type DocText struct{}

var _ application.TextExtractor = DocText{}

// PDF is not ported (see DocText).
func (DocText) PDF(context.Context, []byte, int) ([]string, bool, error) {
	return nil, false, application.ErrNoTextExtractor
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

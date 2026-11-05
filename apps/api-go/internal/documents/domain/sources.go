package domain

import (
	"strconv"
	"strings"

	evidence "github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/domain"
	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// DocumentKind is a readable document kind (sources.ts DOCUMENT_KINDS).
type DocumentKind string

// The kinds of DOCUMENT_KINDS.
const (
	KindPDF  DocumentKind = "pdf"
	KindDOCX DocumentKind = "docx"
	KindText DocumentKind = "text"
)

// MaxPDFPages is MAX_PDF_PAGES.
const MaxPDFPages = 100

// DocumentKindOf is documentKindOf for an extension as extensionOf gives it; "" when unreadable.
func DocumentKindOf(extension string) DocumentKind {
	switch extension {
	case ".pdf":
		return KindPDF
	case ".docx":
		return KindDOCX
	case ".txt", ".md":
		return KindText
	}
	return ""
}

// DocxContent is the text of a Word body: top-level paragraphs (empty ones included) and the
// tables' rows of cells.
type DocxContent struct {
	Paragraphs []string
	Tables     [][][]string
}

// PDFChunks is pdfChunks: one chunk per page with text, `Página n`.
func PDFChunks(pages []string) []TextChunk {
	out := []TextChunk{}
	for i, page := range pages {
		if text := js.TrimJS(page); text != "" {
			out = append(out, TextChunk{Location: "Página " + strconv.Itoa(i+1), Text: text})
		}
	}
	return out
}

// isPipeOrSpace is the class [ |] of docxChunks' emptiness check.
func isPipeOrSpace(r rune) bool { return r == ' ' || r == '|' }

// DocxChunks is docxChunks: paragraphs with text, then table rows whose cells hold any text.
func DocxChunks(c DocxContent) []TextChunk {
	out := []TextChunk{}
	for i, p := range c.Paragraphs {
		if text := js.TrimJS(p); text != "" {
			out = append(out, TextChunk{Location: "Párrafo " + strconv.Itoa(i+1), Text: text})
		}
	}
	for ti, rows := range c.Tables {
		for ri, cells := range rows {
			stripped := make([]string, len(cells))
			for i, cell := range cells {
				stripped[i] = js.TrimJS(cell)
			}
			text := strings.Join(stripped, " | ")
			if strings.TrimFunc(text, isPipeOrSpace) != "" {
				out = append(out, TextChunk{
					Location: "Tabla " + strconv.Itoa(ti+1) + ", fila " + strconv.Itoa(ri+1),
					Text:     text,
				})
			}
		}
	}
	return out
}

// isLineBreak is one code point of Python's str.splitlines() boundaries (LINE_BREAK); CRLF is
// handled by splitLines.
func isLineBreak(r rune) bool {
	switch r {
	case '\n', '\r', '\v', '\f', 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029:
		return true
	}
	return false
}

// splitLines is text.split(LINE_BREAK).
func splitLines(text string) []string {
	var out []string
	start := 0
	for i, r := range text {
		if i < start || !isLineBreak(r) {
			continue
		}
		out = append(out, text[start:i])
		start = i + len(string(r))
		if r == '\r' && start < len(text) && text[start] == '\n' {
			start++
		}
	}
	return append(out, text[start:])
}

// TextChunks is textChunks: UTF-8 with an optional BOM (invalid bytes become U+FFFD), one
// chunk per line with text, `Línea n`.
func TextChunks(data []byte) []TextChunk {
	out := []TextChunk{}
	for i, line := range splitLines(evidence.DecodeUTF8(data, true)) {
		if text := js.TrimJS(line); text != "" {
			out = append(out, TextChunk{Location: "Línea " + strconv.Itoa(i+1), Text: text})
		}
	}
	return out
}

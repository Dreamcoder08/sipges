package domain

import (
	"strings"

	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// Viewer limits of evidence-service.ts: enough to read a report, bounded so one request cannot
// blow up memory.
const (
	PreviewMaxPages = 60
	PreviewMaxChars = 200_000
)

// PreviewFormat is the text format the viewer reads, or "" for images and formats without an
// in-app viewer.
type PreviewFormat string

// The text formats of PreviewFormat.
const (
	FormatPDF  PreviewFormat = "pdf"
	FormatDOCX PreviewFormat = "docx"
	FormatTXT  PreviewFormat = "txt"
	FormatCSV  PreviewFormat = "csv"
)

// PreviewTarget decides what the viewer does with a stored name, before reading any byte:
// image (shown from the download itself), a text format, or unsupported (download only).
func PreviewTarget(originalName string) (image bool, format PreviewFormat) {
	switch ExtensionOf(originalName) {
	case ".jpg", ".jpeg", ".png", ".webp":
		return true, ""
	case ".pdf":
		return false, FormatPDF
	case ".docx":
		return false, FormatDOCX
	case ".txt":
		return false, FormatTXT
	case ".csv":
		return false, FormatCSV
	}
	return false, ""
}

// PlainText is the viewer's text of a .txt or .csv object: TextDecoder('utf-8') (which drops
// one BOM) and then `.replace(/^\ufeff/, ”)`, which drops a second one.
func PlainText(b []byte) string {
	return strings.TrimPrefix(DecodeUTF8(b, true), "\ufeff")
}

// HasText is `pages.some((page) => page.trim())`.
func HasText(pages []string) bool {
	for _, p := range pages {
		if js.TrimJS(p) != "" {
			return true
		}
	}
	return false
}

// Clip is clip of evidence-service.ts: at most PreviewMaxChars UTF-16 units over all pages,
// each page cut with slice (a cut inside a pair keeps the lone high surrogate, as
// JSON.stringify writes it), and whether anything was cut.
func Clip(pages []string) ([]js.Text16, bool) {
	out := []js.Text16{}
	left := PreviewMaxChars
	for _, page := range pages {
		if left <= 0 {
			return out, true
		}
		out = append(out, js.Slice16(page, left))
		left -= js.Len16(page)
	}
	return out, left < 0
}

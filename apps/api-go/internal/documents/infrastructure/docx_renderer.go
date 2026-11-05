package infrastructure

import (
	"archive/zip"
	"bytes"
	"embed"
	"strings"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/domain"
)

// The Word report of docx-renderer.ts. Every part docx@9.15.0 (the version apps/api pins)
// writes for a report is the same whatever the content, except word/document.xml and the
// dates in docProps/core.xml: those parts were taken from its output (docxparts/, MIT
// licensed) and are written back unchanged, in the same order. word/document.xml is written
// with the markup and escaping docx uses, so every part matches byte for byte apart from the
// two dates (testdata/fixtures.json pins it); only the zip container (entry dates, deflate
// output) differs.

// ReportContentType is the media type of the Word report.
const ReportContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

//go:embed all:docxparts
var docxParts embed.FS

// partOrder is the entry order of docx's package; "" marks the generated parts.
var partOrder = []struct{ name, file string }{
	{"word/_rels/document.xml.rels", "word___rels__document.xml.rels"},
	{"word/document.xml", ""},
	{"word/styles.xml", "word__styles.xml"},
	{"docProps/core.xml", ""},
	{"_rels/.rels", "_rels__.rels"},
	{"docProps/custom.xml", "docProps__custom.xml"},
	{"docProps/app.xml", "docProps__app.xml"},
	{"word/footnotes.xml", "word__footnotes.xml"},
	{"word/_rels/footnotes.xml.rels", "word___rels__footnotes.xml.rels"},
	{"word/endnotes.xml", "word__endnotes.xml"},
	{"word/_rels/endnotes.xml.rels", "word___rels__endnotes.xml.rels"},
	{"word/settings.xml", "word__settings.xml"},
	{"word/fontTable.xml", "word__fontTable.xml"},
	{"word/_rels/fontTable.xml.rels", "word___rels__fontTable.xml.rels"},
	{"word/theme/theme1.xml", "word__theme__theme1.xml"},
	{"word/numbering.xml", "word__numbering.xml"},
	{"[Content_Types].xml", "content_types.xml"},
}

const sectionProperties = `<w:sectPr><w:pgSz w:w="11906" w:h="16838" w:orient="portrait"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/><w:pgNumType/><w:docGrid w:linePitch="360"/></w:sectPr>`

const corePrefix = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>SIPGES</dc:creator><cp:lastModifiedBy>Un-named</cp:lastModifiedBy><cp:revision>1</cp:revision>`

// paragraphProperties is the <w:pPr> docx writes for each block kind.
func paragraphProperties(b domain.ReportBlock) string {
	switch b.Kind {
	case domain.BlockTitle:
		return `<w:pPr><w:pStyle w:val="Title"/></w:pPr>`
	case domain.BlockHeading:
		level := "1"
		switch b.Level {
		case 2:
			level = "2"
		case 3:
			level = "3"
		}
		return `<w:pPr><w:pStyle w:val="Heading` + level + `"/></w:pPr>`
	case domain.BlockBullet:
		return `<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>`
	}
	return ""
}

// escapeText is escapeAll of docx's XML writer: markup characters escaped, the C0 controls
// XML 1.0 forbids (all but tab, LF and CR) dropped.
func escapeText(b *strings.Builder, text string) {
	for _, r := range text {
		switch {
		case r == '&':
			b.WriteString("&amp;")
		case r == '"':
			b.WriteString("&quot;")
		case r == '\'':
			b.WriteString("&apos;")
		case r == '<':
			b.WriteString("&lt;")
		case r == '>':
			b.WriteString("&gt;")
		case r <= 0x08 || r == 0x0b || r == 0x0c || (r >= 0x0e && r <= 0x1f):
		default:
			b.WriteRune(r)
		}
	}
}

// documentXML is word/document.xml: each block a paragraph whose lines are runs, every line
// after the first starting with a break (`runs` of docx-renderer.ts).
func documentXML(head []byte, blocks []domain.ReportBlock) []byte {
	var b strings.Builder
	b.Write(head)
	b.WriteString("<w:body>")
	for _, block := range blocks {
		b.WriteString("<w:p>")
		b.WriteString(paragraphProperties(block))
		for i, line := range strings.Split(block.Text, "\n") {
			b.WriteString(`<w:r><w:rPr><w:b w:val="false"/><w:bCs w:val="false"/></w:rPr>`)
			if i > 0 {
				b.WriteString("<w:br/>")
			}
			b.WriteString(`<w:t xml:space="preserve">`)
			escapeText(&b, line)
			b.WriteString("</w:t></w:r>")
		}
		b.WriteString("</w:p>")
	}
	b.WriteString(sectionProperties)
	b.WriteString("</w:body></w:document>")
	return []byte(b.String())
}

func coreXML(at time.Time) []byte {
	stamp := at.UTC().Format("2006-01-02T15:04:05.000Z")
	return []byte(corePrefix +
		`<dcterms:created xsi:type="dcterms:W3CDTF">` + stamp + `</dcterms:created>` +
		`<dcterms:modified xsi:type="dcterms:W3CDTF">` + stamp + `</dcterms:modified></cp:coreProperties>`)
}

// RenderParts returns every part of the report package by name, in package order.
func RenderParts(blocks []domain.ReportBlock, at time.Time) ([]string, map[string][]byte, error) {
	head, err := docxParts.ReadFile("docxparts/document_head.xml")
	if err != nil {
		return nil, nil, err
	}
	names := make([]string, 0, len(partOrder))
	parts := make(map[string][]byte, len(partOrder))
	for _, p := range partOrder {
		var data []byte
		switch p.name {
		case "word/document.xml":
			data = documentXML(head, blocks)
		case "docProps/core.xml":
			data = coreXML(at)
		default:
			if data, err = docxParts.ReadFile("docxparts/" + p.file); err != nil {
				return nil, nil, err
			}
		}
		names = append(names, p.name)
		parts[p.name] = data
	}
	return names, parts, nil
}

// DocxRenderer writes the format-neutral report outline as an Office Open XML document, fully
// in memory.
type DocxRenderer struct{}

// ContentType is the report's media type.
func (DocxRenderer) ContentType() string { return ReportContentType }

// Render is docxRenderer.render.
func (DocxRenderer) Render(blocks []domain.ReportBlock, at time.Time) ([]byte, error) {
	names, parts, err := RenderParts(blocks, at)
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	for _, name := range names {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: at.UTC()})
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(parts[name]); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

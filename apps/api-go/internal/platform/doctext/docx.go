// Package doctext reads the text of untrusted Word documents the way the TypeScript API does
// (apps/api/src/contexts/documents/infrastructure/document-reader.ts): fflate 0.8.3's unzipSync
// for the one part it needs, then the same minimal, non-validating WordprocessingML reader. The
// document lab and the evidence viewer share it, as they share the reader in apps/api.
package doctext

import (
	"bytes"
	"compress/flate"
	"context"
	"errors"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"
)

// documentPart is the body part of a Word package.
const documentPart = "word/document.xml"

// MaxDocumentXMLBytes is MAX_DOCUMENT_XML_BYTES: a larger uncompressed body part is treated as
// a zip bomb and the document as unreadable.
const MaxDocumentXMLBytes = 32 * 1024 * 1024

// ErrUnreadable is any document the reader refuses; the routes answer it without details.
var ErrUnreadable = errors.New("doctext: unreadable document")

// Content is the text of a Word body: its top-level paragraphs (empty ones included) and, for
// each top-level table, its rows of cells (a cell's paragraphs joined with "\n").
type Content struct {
	Paragraphs []string
	Tables     [][][]string
}

// ReadDOCX is readDocx: the body part of the package, then its paragraphs and tables. ctx bounds
// the work (checked while walking the zip directory, inflating and reading the markup); a
// cancelled read is ErrUnreadable too.
func ReadDOCX(ctx context.Context, data []byte) (Content, error) {
	part, err := unzipPart(ctx, data)
	if err != nil {
		return Content{}, ErrUnreadable
	}
	root, err := parseXML(ctx, DecodeUTF8(part, true))
	if err != nil {
		return Content{}, ErrUnreadable
	}
	var body *node
	for _, d := range root.elements("w:document") {
		if bodies := d.elements("w:body"); len(bodies) > 0 {
			body = bodies[0]
			break
		}
	}
	if body == nil {
		return Content{}, ErrUnreadable
	}
	c := Content{Paragraphs: []string{}, Tables: [][][]string{}}
	for _, p := range body.elements("w:p") {
		c.Paragraphs = append(c.Paragraphs, paragraphText(p))
	}
	for _, tbl := range body.elements("w:tbl") {
		rows := [][]string{}
		for _, tr := range tbl.elements("w:tr") {
			cells := []string{}
			for _, tc := range tr.elements("w:tc") {
				var texts []string
				for _, p := range tc.elements("w:p") {
					texts = append(texts, paragraphText(p))
				}
				cells = append(cells, strings.Join(texts, "\n"))
			}
			rows = append(rows, cells)
		}
		c.Tables = append(c.Tables, rows)
	}
	return c, nil
}

// zipBytes reads little-endian fields as fflate does: bytes past the end read as 0.
type zipBytes []byte

func (d zipBytes) at(i int) uint32 {
	if i < 0 || i >= len(d) {
		return 0
	}
	return uint32(d[i])
}
func (d zipBytes) b2(i int) int { return int(d.at(i) | d.at(i+1)<<8) }
func (d zipBytes) b4(i int) int {
	return int(d.at(i) | d.at(i+1)<<8 | d.at(i+2)<<16 | d.at(i+3)<<24)
}
func (d zipBytes) b8(i int) int { return d.b4(i) + d.b4(i+4)*4294967296 }

// slice is Uint8Array#subarray / slc: bounds clamped to the data.
func (d zipBytes) slice(start, end int) []byte {
	start = min(max(start, 0), len(d))
	end = min(max(end, start), len(d))
	return d[start:end]
}

const (
	sigEOCD      = 0x6054B50
	sigEOCD64Loc = 0x7064B50
	sigEOCD64    = 0x6064B50
	maxComment   = 65558
)

// unzipPart is unzipSync(data, { filter }) for the body part (no larger than
// MaxDocumentXMLBytes uncompressed), ported from fflate 0.8.3: the end of central directory is
// searched backwards, the central directory is trusted for sizes and offsets, the last entry
// of the name wins, and no checksum is verified. A deflated part that does not inflate to its
// declared size is refused (fflate would keep what fits).
//
// Hostile packages are bounded where fflate is not: the entry count is capped at the entries
// the data can hold (past the data every field reads as 0, so such entries name nothing and
// fflate's answer is the same), only the last matching entry is inflated (fflate inflates every
// duplicate; known divergence: an earlier duplicate that fails to inflate makes fflate throw,
// and is ignored here), and ctx is checked between entries and while inflating.
func unzipPart(ctx context.Context, raw []byte) ([]byte, error) {
	d := zipBytes(raw)
	e := len(d) - 22
	for d.b4(e) != sigEOCD {
		if e == 0 || len(d)-e > maxComment {
			return nil, ErrUnreadable
		}
		e--
	}
	count := d.b2(e + 8)
	offset := d.b4(e + 16)
	z64 := d.b4(e-20) == sigEOCD64Loc
	if z64 {
		ze := d.b4(e - 12)
		z64 = d.b4(ze) == sigEOCD64
		if z64 {
			count = d.b4(ze + 32)
			offset = d.b4(ze + 48)
		}
	}
	count = min(count, len(d)/46+1)
	found := false
	var method, start, compressed, size int
	for i := range count {
		if i%1024 == 0 && ctx.Err() != nil {
			return nil, ctx.Err()
		}
		entryMethod := d.b2(offset + 10)
		nameLen, extraLen := d.b2(offset+28), d.b2(offset+30)
		nameBytes := d.slice(offset+46, offset+46+nameLen)
		name := latin1(nameBytes)
		if d.b2(offset+8)&2048 != 0 {
			name = DecodeUTF8(nameBytes, true)
		}
		extra := offset + 46 + nameLen
		entryCompressed, entrySize, local := d.b4(offset+20), d.b4(offset+24), d.b4(offset+42)
		if z64 {
			var ok bool
			entryCompressed, entrySize, local, ok = zip64Sizes(d, extra, extraLen, entryCompressed, entrySize, local)
			if !ok {
				return nil, ErrUnreadable
			}
		}
		next := extra + extraLen + d.b2(offset+32)
		entryStart := local + 30 + d.b2(local+26) + d.b2(local+28)
		offset = next
		if name != documentPart || entrySize > MaxDocumentXMLBytes {
			continue
		}
		if entryMethod != 0 && entryMethod != 8 {
			return nil, ErrUnreadable // unknown compression type
		}
		found = true
		method, start, compressed, size = entryMethod, entryStart, entryCompressed, entrySize
	}
	if !found {
		return nil, ErrUnreadable
	}
	if method == 0 {
		return bytes.Clone(d.slice(start, start+compressed)), nil
	}
	return inflate(ctx, d.slice(start, start+compressed), size)
}

// zip64Sizes is z64hs with z = 1: sizes and offset saturated at 0xFFFFFFFF come from the
// ZIP64 extra field, which must then exist.
func zip64Sizes(d zipBytes, b, length, compressed, size, local int) (int, int, int, bool) {
	const saturated = 4294967295
	nsc, nsu, noff := compressed == saturated, size == saturated, local == saturated
	if !nsc && !nsu && !noff {
		return compressed, size, local, true
	}
	n := func(flag bool) int {
		if flag {
			return 1
		}
		return 0
	}
	for e := b + length; b+4 < e; b += 4 + d.b2(b+2) {
		if d.b2(b) == 1 {
			if nsc {
				compressed = d.b8(b + 4 + 8*n(nsu))
			}
			if nsu {
				size = d.b8(b + 4)
			}
			if noff {
				local = d.b8(b + 4 + 8*(n(nsu)+n(nsc)))
			}
			return compressed, size, local, true
		}
	}
	return 0, 0, 0, false
}

// ctxReader stops a read once ctx ends.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

func inflate(ctx context.Context, compressed []byte, size int) ([]byte, error) {
	r := flate.NewReader(bytes.NewReader(compressed))
	defer func() { _ = r.Close() }()
	out, err := io.ReadAll(io.LimitReader(ctxReader{ctx, r}, int64(size)+1))
	if err != nil || len(out) != size {
		return nil, ErrUnreadable
	}
	return out, nil
}

func latin1(b []byte) string {
	var s strings.Builder
	for _, c := range b {
		s.WriteRune(rune(c))
	}
	return s.String()
}

// node is an element of the markup tree, or (name "") a text child.
type node struct {
	name     string
	text     string
	children []*node
}

func (n *node) elements(name string) []*node {
	var out []*node
	for _, c := range n.children {
		if c.name == name {
			out = append(out, c)
		}
	}
	return out
}

var errMalformed = errors.New("doctext: malformed XML")

// checkEvery is how many tokens are read between two context checks.
const checkEvery = 4096

// MaxNodes bounds the markup tree: a 32 MiB part of empty elements would otherwise hold some
// 8 million nodes (about 670 MiB). Known divergence: TypeScript reads such a part (Word never
// writes one; two million elements are thousands of pages), this port answers it unreadable.
const MaxNodes = 2_000_000

// parseXML is parseXml: the tokens of
// /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>|([^<]+)/g in order
// (a '<' that starts none of them is skipped), building elements and text only.
func parseXML(ctx context.Context, xml string) (*node, error) {
	root := &node{name: "#root"}
	stack := []*node{root}
	tokens := 0
	for p := 0; p < len(xml); {
		tokens++
		if tokens%checkEvery == 0 && ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if tokens > MaxNodes {
			return nil, errMalformed
		}
		parent := stack[len(stack)-1]
		if xml[p] != '<' {
			end := strings.IndexByte(xml[p:], '<')
			if end < 0 {
				end = len(xml) - p
			}
			text, err := decodeEntities(xml[p : p+end])
			if err != nil {
				return nil, err
			}
			parent.children = append(parent.children, &node{text: text})
			p += end
			continue
		}
		if strings.HasPrefix(xml[p:], "<?") {
			if end := strings.Index(xml[p+2:], "?>"); end >= 0 {
				p += 2 + end + 2
				continue
			}
		}
		if strings.HasPrefix(xml[p:], "<!--") {
			if end := strings.Index(xml[p+4:], "-->"); end >= 0 {
				p += 4 + end + 3
				continue
			}
		}
		if name, closing, selfClosing, end, ok := tag(xml, p); ok {
			switch {
			case closing:
				if parent.name != name {
					return nil, errMalformed
				}
				stack = stack[:len(stack)-1]
			default:
				n := &node{name: name}
				parent.children = append(parent.children, n)
				if !selfClosing {
					stack = append(stack, n)
				}
			}
			p = end
			continue
		}
		p++ // a '<' that starts no token
	}
	if len(stack) != 1 {
		return nil, errMalformed
	}
	return root, nil
}

func isNameStart(c byte) bool { return c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c == '_' }
func isNameChar(c byte) bool {
	return isNameStart(c) || c >= '0' && c <= '9' || c == ':' || c == '.' || c == '-'
}

// tag matches <(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)> at p: the element ends at the first '>'
// after its name, and is self-closing when a '/' sits right before that '>'.
func tag(xml string, p int) (name string, closing, selfClosing bool, end int, ok bool) {
	i := p + 1
	if i < len(xml) && xml[i] == '/' {
		closing = true
		i++
	}
	if i >= len(xml) || !isNameStart(xml[i]) {
		return "", false, false, 0, false
	}
	start := i
	for i < len(xml) && isNameChar(xml[i]) {
		i++
	}
	name = xml[start:i]
	gt := strings.IndexByte(xml[i:], '>')
	if gt < 0 {
		return "", false, false, 0, false
	}
	gt += i
	selfClosing = gt > i && xml[gt-1] == '/'
	return name, closing, selfClosing, gt + 1, true
}

// constructorText is what `ENTITIES['constructor'] ?? whole` puts in place of "&constructor;":
// the inherited Object constructor, converted to a string by String#replace.
const constructorText = "function Object() { [native code] }"

var entities = map[string]string{
	"amp": "&", "lt": "<", "gt": ">", "quot": `"`, "apos": "'",
	"constructor": constructorText,
}

// decodeEntities is decodeEntities: /&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g replaced. A numeric
// reference past U+10FFFF throws in String.fromCodePoint, which makes the document
// unreadable. Known divergence: a reference to a surrogate (U+D800–U+DFFF, never well-formed
// XML) gives a lone surrogate in JavaScript and U+FFFD here.
func decodeEntities(text string) (string, error) {
	if !strings.Contains(text, "&") {
		return text, nil
	}
	var b strings.Builder
	for i := 0; i < len(text); {
		if text[i] != '&' {
			b.WriteByte(text[i])
			i++
			continue
		}
		replacement, length, err := entityAt(text[i:])
		if err != nil {
			return "", err
		}
		if length == 0 {
			b.WriteByte('&')
			i++
			continue
		}
		b.WriteString(replacement)
		i += length
	}
	return b.String(), nil
}

// entityAt matches one reference at the start of s (s[0] == '&'): its replacement and length,
// or length 0 when none matches there.
func entityAt(s string) (string, int, error) {
	run := func(from int, accept func(byte) bool) int {
		j := from
		for j < len(s) && accept(s[j]) {
			j++
		}
		return j
	}
	isHex := func(c byte) bool { return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F' }
	isDigit := func(c byte) bool { return c >= '0' && c <= '9' }
	isLower := func(c byte) bool { return c >= 'a' && c <= 'z' }
	if strings.HasPrefix(s, "&#x") {
		if j := run(3, isHex); j > 3 && j < len(s) && s[j] == ';' {
			r, err := codePoint(s[3:j], 16)
			return r, j + 1, err
		}
	}
	if strings.HasPrefix(s, "&#") {
		if j := run(2, isDigit); j > 2 && j < len(s) && s[j] == ';' {
			r, err := codePoint(s[2:j], 10)
			return r, j + 1, err
		}
	}
	if j := run(1, isLower); j > 1 && j < len(s) && s[j] == ';' {
		if r, ok := entities[s[1:j]]; ok {
			return r, j + 1, nil
		}
		return s[:j+1], j + 1, nil
	}
	return "", 0, nil
}

// codePoint is String.fromCodePoint(Number.parseInt(digits, base)).
func codePoint(digits string, base int) (string, error) {
	digits = strings.TrimLeft(digits, "0")
	if len(digits) > 8 {
		return "", errMalformed // far past U+10FFFF: RangeError
	}
	n, err := strconv.ParseUint("0"+digits, base, 64)
	if err != nil || n > utf8.MaxRune {
		return "", errMalformed
	}
	if n >= 0xD800 && n <= 0xDFFF {
		return string(utf8.RuneError), nil
	}
	return string(rune(n)), nil
}

// skippedInParagraph are properties and floating content (text boxes, drawings), which are not
// paragraph text in python-docx.
var skippedInParagraph = map[string]bool{
	"w:pPr": true, "w:rPr": true, "w:drawing": true, "w:pict": true, "w:object": true,
	"mc:AlternateContent": true,
}

// paragraphText is python-docx `Paragraph.text`: run text, tabs as "\t", breaks as "\n". It
// walks with an explicit stack, so a deeply nested paragraph cannot exhaust the goroutine stack
// (V8 throws past its own stack depth, which makes such a document unreadable there).
func paragraphText(p *node) string {
	var out strings.Builder
	type frame struct {
		n *node
		i int
	}
	stack := []frame{{p, 0}}
	for len(stack) > 0 {
		top := &stack[len(stack)-1]
		if top.i >= len(top.n.children) {
			stack = stack[:len(stack)-1]
			continue
		}
		child := top.n.children[top.i]
		top.i++
		switch {
		case child.name == "":
		case child.name == "w:t":
			for _, c := range child.children {
				if c.name == "" {
					out.WriteString(c.text)
				}
			}
		case child.name == "w:tab":
			out.WriteByte('\t')
		case child.name == "w:br" || child.name == "w:cr":
			out.WriteByte('\n')
		case !skippedInParagraph[child.name]:
			stack = append(stack, frame{child, 0})
		}
	}
	return out.String()
}

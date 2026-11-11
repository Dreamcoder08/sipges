package httpx

import (
	"bytes"
	"regexp"
	"strings"
	"unicode/utf8"
)

// A form body as `c.req.parseBody()` reads it on @hono/node-server (Hono 4.13.14 over the
// undici 6.29 that Node 22 bundles): Hono's media type check, then Response#formData() with
// undici's MIME type extraction and its multipart/form-data and urlencoded parsers, ported line
// for line from lib/web/fetch/{body,util,data-url,formdata-parser}.js. Strings there are
// UTF-16; header values here are their bytes, one Latin-1 character each, as Node reads them.
// testdata/form.json was recorded from Hono on synthetic bodies and pins this port.

// FormEntry is one FormData entry: text, or a File with its name and bytes.
type FormEntry struct {
	Name string
	File bool
	// Text is the value, or the file's name.
	Text string
	Data []byte
}

// ParseForm is `await c.req.parseBody()` as an entry list: ok=false when it throws (the
// route's 422 "Invalid form body"); an empty list when the media type is not a form one.
func ParseForm(contentType string, present bool, body []byte) ([]FormEntry, bool) {
	if !present {
		return nil, true
	}
	// Hono: contentType.split(';')[0].trim().toLowerCase()
	media, _, _ := strings.Cut(contentType, ";")
	media = latin1Lower(trimBytes(media, isJSTrimByte))
	if media != "multipart/form-data" && media != "application/x-www-form-urlencoded" {
		return nil, true
	}
	// bufferToFormData: the media type (up to the first ';') lower-cased, then a new Response
	// whose Headers trim HTTP whitespace from the value.
	header := contentType
	if i := strings.IndexByte(header, ';'); i != 0 {
		if i < 0 {
			i = len(header)
		}
		header = latin1Lower(header[:i]) + header[i:]
	}
	header = trimBytes(header, isHTTPWhitespace)
	if strings.ContainsAny(header, "\x00\r\n") {
		return nil, false // Headers refuses the value: TypeError
	}
	mime, ok := extractMIMEType(header)
	if !ok {
		return nil, false
	}
	switch mime.essence {
	case "multipart/form-data":
		boundary, has := mime.params["boundary"]
		if !has {
			return nil, false
		}
		return multipartFormData(body, boundary)
	case "application/x-www-form-urlencoded":
		return urlencoded(body), true
	}
	return nil, false
}

// isJSTrimByte is String.prototype.trim's set within Latin-1: tab, LF, VT, FF, CR, space, NBSP.
func isJSTrimByte(c byte) bool {
	return c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r' || c == ' ' || c == 0xa0
}

// trimBytes trims bytes (Latin-1 characters) from both ends; strings.Trim would read the
// string as UTF-8.
func trimBytes(s string, drop func(byte) bool) string {
	start, end := 0, len(s)
	for start < end && drop(s[start]) {
		start++
	}
	for end > start && drop(s[end-1]) {
		end--
	}
	return s[start:end]
}

// latin1Lower is toLowerCase on a string of Latin-1 characters: A-Z and À-Þ (but ×).
func latin1Lower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' || 0xc0 <= c && c <= 0xde && c != 0xd7 {
			b[i] = c + 0x20
		}
	}
	return string(b)
}

type mimeType struct {
	essence string
	params  map[string]string
}

// extractMIMEType is extractMimeType of util.js on one header value: get, decode and split,
// then the last value that parses (and is not */*) wins.
func extractMIMEType(value string) (mimeType, bool) {
	var found *mimeType
	for _, v := range getDecodeSplit(value) {
		m, ok := parseMIMEType(v)
		if !ok || m.essence == "*/*" {
			continue
		}
		found = &m
	}
	if found == nil {
		return mimeType{}, false
	}
	return *found, true
}

// getDecodeSplit is gettingDecodingSplitting: split on commas outside quoted strings.
func getDecodeSplit(input string) []string {
	var values []string
	pos := 0
	temporary := ""
	for pos < len(input) {
		start := pos
		for pos < len(input) && input[pos] != '"' && input[pos] != ',' {
			pos++
		}
		temporary += input[start:pos]
		if pos < len(input) {
			if input[pos] == '"' {
				quoted, next := collectQuotedString(input, pos, false)
				temporary += quoted
				pos = next
				if pos < len(input) {
					continue
				}
			} else {
				pos++ // the comma
			}
		}
		values = append(values, removeChars(temporary, true, isTabOrSpace))
		temporary = ""
	}
	return values
}

func isTabOrSpace(c byte) bool     { return c == '\t' || c == ' ' }
func isHTTPWhitespace(c byte) bool { return c == '\r' || c == '\n' || c == '\t' || c == ' ' }

// removeChars is removeChars of util.js and data-url.js (every caller trims the end), with
// their quirk: the trailing scan stops at index 1, so a value made only of removable characters
// keeps its first one unless the leading scan also runs.
func removeChars(s string, leading bool, pred func(byte) bool) string {
	lead, trail := 0, len(s)-1
	if leading {
		for lead < len(s) && pred(s[lead]) {
			lead++
		}
	}
	for trail > 0 && pred(s[trail]) {
		trail--
	}
	if lead == 0 && trail == len(s)-1 {
		return s
	}
	if trail+1 < lead {
		return ""
	}
	return s[lead : trail+1]
}

// collectQuotedString is collectAnHTTPQuotedString from input[pos] == '"': the value (extract)
// or the raw quoted text, and the position after it.
func collectQuotedString(input string, pos int, extract bool) (string, int) {
	start := pos
	var value strings.Builder
	pos++
	for {
		s := pos
		for pos < len(input) && input[pos] != '"' && input[pos] != '\\' {
			pos++
		}
		value.WriteString(input[s:pos])
		if pos >= len(input) {
			break
		}
		c := input[pos]
		pos++
		if c == '\\' {
			if pos >= len(input) {
				value.WriteByte('\\')
				break
			}
			value.WriteByte(input[pos])
			pos++
			continue
		}
		break
	}
	if extract {
		return value.String(), pos
	}
	return input[start:pos], pos
}

var httpToken = regexp.MustCompile(`^[!#$%&'*+\-.^_|~A-Za-z0-9]+$`)

// isToken is HTTP_TOKEN_CODEPOINTS.test on a string of Latin-1 characters.
func isToken(s string) bool { return httpToken.MatchString(s) }

// isQuotedTokens is HTTP_QUOTED_STRING_TOKENS.test: every byte is a Latin-1 character, so only
// the control characters fail.
func isQuotedTokens(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c != '\t' && (c < 0x20 || c == 0x7f) {
			return false
		}
	}
	return s != ""
}

func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			b[i] = c + 0x20
		}
	}
	return string(b)
}

// parseMIMEType is parseMIMEType of data-url.js.
func parseMIMEType(input string) (mimeType, bool) {
	input = removeChars(input, true, isHTTPWhitespace)
	pos := strings.IndexByte(input, '/')
	if pos < 0 {
		pos = len(input)
	}
	typ := input[:pos]
	if typ == "" || !isToken(typ) || pos > len(input) {
		return mimeType{}, false
	}
	pos++
	rest := ""
	if pos <= len(input) {
		rest = input[pos:]
	}
	end := strings.IndexByte(rest, ';')
	if end < 0 {
		end = len(rest)
	}
	subtype := removeChars(rest[:end], false, isHTTPWhitespace)
	pos += end
	if subtype == "" || !isToken(subtype) {
		return mimeType{}, false
	}
	m := mimeType{essence: asciiLower(typ) + "/" + asciiLower(subtype), params: map[string]string{}}
	for pos < len(input) {
		pos++ // the ';'
		for pos < len(input) && isHTTPWhitespace(input[pos]) {
			pos++
		}
		start := pos
		for pos < len(input) && input[pos] != ';' && input[pos] != '=' {
			pos++
		}
		name := asciiLower(input[start:pos])
		if pos < len(input) {
			if input[pos] == ';' {
				continue
			}
			pos++ // the '='
		}
		if pos > len(input) {
			break
		}
		var value string
		if pos < len(input) && input[pos] == '"' {
			value, pos = collectQuotedString(input, pos, true)
			if i := strings.IndexByte(input[pos:], ';'); i >= 0 {
				pos += i
			} else {
				pos = len(input)
			}
		} else {
			start := pos
			if i := strings.IndexByte(input[pos:], ';'); i >= 0 {
				pos += i
			} else {
				pos = len(input)
			}
			value = removeChars(input[start:pos], false, isHTTPWhitespace)
			if value == "" {
				continue
			}
		}
		if _, exists := m.params[name]; name != "" && isToken(name) && (value == "" || isQuotedTokens(value)) && !exists {
			m.params[name] = value
		}
	}
	return m, true
}

// latin1ToUTF8 is Buffer.from(string, 'utf8') for a string of Latin-1 characters.
func latin1ToUTF8(s string) []byte {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		out = utf8.AppendRune(out, rune(s[i]))
	}
	return out
}

var (
	formDataName = []byte(`form-data; name="`)
	filenameAttr = []byte(`; filename`)
)

// multipartFormData is multipartFormDataParser of formdata-parser.js (undici 6.29.1), quirks
// included: leading and trailing CRLFs are ignored, a part's body ends four bytes before the
// next occurrence of the bare boundary string, and a header line ends at CR or LF.
func multipartFormData(input []byte, boundaryString string) ([]FormEntry, bool) {
	boundary := append([]byte("--"), latin1ToUTF8(boundaryString)...)
	entries := []FormEntry{}
	pos := 0
	for pos+1 < len(input) && input[pos] == '\r' && input[pos+1] == '\n' {
		pos += 2
	}
	trailing := len(input)
	for trailing >= 2 && input[trailing-1] == '\n' && input[trailing-2] == '\r' {
		trailing -= 2
	}
	input = input[:trailing]
	for {
		if pos > len(input) || !bytes.Equal(input[pos:min(len(input), pos+len(boundary))], boundary) {
			return nil, false
		}
		pos += len(boundary)
		if (pos == len(input)-2 && bytes.HasPrefix(input[pos:], []byte("--"))) ||
			(pos == len(input)-4 && bytes.HasPrefix(input[pos:], []byte("--\r\n"))) {
			return entries, true
		}
		if formAt(input, pos) != '\r' || formAt(input, pos+1) != '\n' {
			return nil, false
		}
		pos += 2
		h, next, ok := multipartHeaders(input, pos)
		if !ok {
			return nil, false
		}
		pos = next + 2
		idx := bytes.Index(input[min(pos, len(input)):], boundary[2:])
		if idx < 0 {
			return nil, false
		}
		idx += min(pos, len(input))
		// body = input.subarray(position, boundaryIndex - 4): empty when the end is before the start.
		var body []byte
		if end := idx - 4; end > pos {
			body = input[pos:end]
		}
		pos += len(body)
		if h.encoding == "base64" {
			body = nodeBase64(DecodeUTF8(body, false))
		}
		if formAt(input, pos) != '\r' || formAt(input, pos+1) != '\n' {
			return nil, false
		}
		pos += 2
		if h.filename != nil {
			entries = append(entries, FormEntry{Name: h.name, File: true, Text: *h.filename, Data: append([]byte{}, body...)})
		} else {
			entries = append(entries, FormEntry{Name: h.name, Text: utf8DecodeBytes(body)})
		}
	}
}

// at is input[i] in JavaScript: undefined (here -1) past the end.
func formAt(input []byte, i int) int {
	if i < 0 || i >= len(input) {
		return -1
	}
	return int(input[i])
}

type partHeaders struct {
	name     string
	filename *string
	encoding string
}

// multipartHeaders is parseMultipartFormDataHeaders; next is the position of the CRLF that ends
// the headers.
func multipartHeaders(input []byte, pos int) (partHeaders, int, bool) {
	var h partHeaders
	hasName := false
	for {
		if formAt(input, pos) == '\r' && formAt(input, pos+1) == '\n' {
			if !hasName {
				return h, 0, false
			}
			return h, pos, true
		}
		start := pos
		for pos < len(input) && input[pos] != '\n' && input[pos] != '\r' && input[pos] != ':' {
			pos++
		}
		headerName := removeChars(string(input[start:pos]), true, isTabOrSpace)
		// HTTP_TOKEN_CODEPOINTS.test(headerName.toString()): a UTF-8 decoding, so any non-ASCII
		// byte fails the ASCII-only pattern.
		if !isToken(headerName) {
			return h, 0, false
		}
		if formAt(input, pos) != ':' {
			return h, 0, false
		}
		pos++
		for pos < len(input) && (input[pos] == ' ' || input[pos] == '\t') {
			pos++
		}
		switch asciiLower(headerName) {
		case "content-disposition":
			h.filename = nil
			if !bytes.HasPrefix(input[pos:], formDataName) {
				return h, 0, false
			}
			pos += len(formDataName)
			name, next, ok := multipartName(input, pos)
			if !ok {
				return h, 0, false
			}
			h.name, hasName, pos = name, true, next
			if bytes.HasPrefix(input[pos:], filenameAttr) {
				check := pos + len(filenameAttr)
				if formAt(input, check) == '*' {
					pos++
					check++
				}
				if formAt(input, check) != '=' || formAt(input, check+1) != '"' {
					return h, 0, false
				}
				pos += 12
				filename, next, ok := multipartName(input, pos)
				if !ok {
					return h, 0, false
				}
				h.filename, pos = &filename, next
			}
		case "content-transfer-encoding":
			start := pos
			for pos < len(input) && input[pos] != '\n' && input[pos] != '\r' {
				pos++
			}
			h.encoding = removeChars(string(input[start:pos]), false, isTabOrSpace)
		default: // content-type (only a File's type, which the upload ignores) and the rest
			for pos < len(input) && input[pos] != '\n' && input[pos] != '\r' {
				pos++
			}
		}
		// The original's condition: failure only when neither byte matches.
		if formAt(input, pos) != '\r' && formAt(input, pos+1) != '\n' {
			return h, 0, false
		}
		pos += 2
	}
}

// multipartName is parseMultipartFormDataName from just after a '"': the bytes up to the next
// '"' (no CR or LF), decoded with TextDecoder, then %0A, %0D (any case) and %22 replaced.
func multipartName(input []byte, pos int) (string, int, bool) {
	start := pos
	for pos < len(input) && input[pos] != '\n' && input[pos] != '\r' && input[pos] != '"' {
		pos++
	}
	if formAt(input, pos) != '"' {
		return "", 0, false
	}
	name := DecodeUTF8(input[start:pos], true)
	name = strings.NewReplacer("%0A", "\n", "%0a", "\n").Replace(name)
	name = strings.NewReplacer("%0D", "\r", "%0d", "\r").Replace(name)
	name = strings.ReplaceAll(name, "%22", `"`)
	return name, pos + 1, true
}

// utf8DecodeBytes is utf8DecodeBytes of util.js: one BOM dropped by hand, then TextDecoder,
// which drops another.
func utf8DecodeBytes(b []byte) string {
	if len(b) >= 3 && b[0] == 0xef && b[1] == 0xbb && b[2] == 0xbf {
		b = b[3:]
	}
	return DecodeUTF8(b, true)
}

// nodeBase64 is Buffer.from(string, 'base64'): characters of either alphabet are decoded,
// any other is skipped (by the low byte of its UTF-16 unit), and the first '=' ends the data.
func nodeBase64(s string) []byte {
	var units []uint16
	for _, r := range s {
		if r >= 0x10000 {
			r -= 0x10000
			units = append(units, uint16(0xd800+(r>>10)), uint16(0xdc00+(r&0x3ff))) //nolint:gosec // in range
			continue
		}
		units = append(units, uint16(r)) //nolint:gosec // a BMP code point
	}
	out := []byte{}
	var acc uint32
	n := 0
	for _, u := range units {
		c := byte(u) //nolint:gosec // Node keeps the low byte
		v, ok := base64Value(c)
		if !ok {
			if c == '=' {
				break
			}
			continue
		}
		acc = acc<<6 | uint32(v)
		n++
		if n == 4 {
			out = append(out, byte(acc>>16), byte(acc>>8), byte(acc)) //nolint:gosec // byte-wise truncation intended
			acc, n = 0, 0
		}
	}
	switch n {
	case 2:
		out = append(out, byte(acc>>4))
	case 3:
		out = append(out, byte(acc>>10), byte(acc>>2))
	}
	return out
}

func base64Value(c byte) (byte, bool) {
	switch {
	case 'A' <= c && c <= 'Z':
		return c - 'A', true
	case 'a' <= c && c <= 'z':
		return c - 'a' + 26, true
	case '0' <= c && c <= '9':
		return c - '0' + 52, true
	case c == '+' || c == '-':
		return 62, true
	case c == '/' || c == '_':
		return 63, true
	}
	return 0, false
}

// urlencoded is `new URLSearchParams(body.toString())` (Node's parser): the body decoded as
// UTF-8, a leading '?' dropped, pairs split on '&', '+' read as a space, percent escapes
// decoded to bytes and those decoded as UTF-8 (a BOM kept).
func urlencoded(body []byte) []FormEntry {
	s := DecodeUTF8(body, false)
	s = strings.TrimPrefix(s, "?")
	entries := []FormEntry{}
	for pair := range strings.SplitSeq(s, "&") {
		if pair == "" {
			continue
		}
		name, value, _ := strings.Cut(pair, "=")
		entries = append(entries, FormEntry{Name: formDecode(name), Text: formDecode(value)})
	}
	return entries
}

func formDecode(s string) string {
	b := []byte(strings.ReplaceAll(s, "+", " "))
	out := make([]byte, 0, len(b))
	for i := 0; i < len(b); i++ {
		if b[i] == '%' && i+2 < len(b) {
			if hi, ok := formHex(b[i+1]); ok {
				if lo, ok := formHex(b[i+2]); ok {
					out = append(out, hi<<4|lo)
					i += 2
					continue
				}
			}
		}
		out = append(out, b[i])
	}
	return DecodeUTF8(out, false)
}

func formHex(c byte) (byte, bool) {
	switch {
	case '0' <= c && c <= '9':
		return c - '0', true
	case 'a' <= c && c <= 'f':
		return c - 'a' + 10, true
	case 'A' <= c && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// DecodeUTF8 is the WHATWG UTF-8 decoder with replacement, as evidence DecodeUTF8 and TextDecoder
// read bytes: one U+FFFD per maximal invalid sequence, the BOM dropped when stripBOM is set.
func DecodeUTF8(b []byte, stripBOM bool) string {
	if stripBOM && len(b) >= 3 && b[0] == 0xef && b[1] == 0xbb && b[2] == 0xbf {
		b = b[3:]
	}
	if utf8.Valid(b) {
		return string(b)
	}
	out := make([]rune, 0, len(b))
	var cp rune
	needed, seen := 0, 0
	lower, upper := byte(0x80), byte(0xbf)
	for i := 0; i < len(b); i++ {
		c := b[i]
		if needed == 0 {
			switch {
			case c <= 0x7f:
				out = append(out, rune(c))
			case c >= 0xc2 && c <= 0xdf:
				needed, cp = 1, rune(c&0x1f)
			case c >= 0xe0 && c <= 0xef:
				if c == 0xe0 {
					lower = 0xa0
				}
				if c == 0xed {
					upper = 0x9f
				}
				needed, cp = 2, rune(c&0x0f)
			case c >= 0xf0 && c <= 0xf4:
				if c == 0xf0 {
					lower = 0x90
				}
				if c == 0xf4 {
					upper = 0x8f
				}
				needed, cp = 3, rune(c&0x07)
			default:
				out = append(out, utf8.RuneError)
			}
			continue
		}
		if c < lower || c > upper {
			cp, needed, seen = 0, 0, 0
			lower, upper = 0x80, 0xbf
			out = append(out, utf8.RuneError)
			i-- // the byte starts the next sequence
			continue
		}
		lower, upper = 0x80, 0xbf
		cp = cp<<6 | rune(c&0x3f)
		seen++
		if seen == needed {
			out = append(out, cp)
			cp, needed, seen = 0, 0, 0
		}
	}
	if needed != 0 {
		out = append(out, utf8.RuneError)
	}
	return string(out)
}

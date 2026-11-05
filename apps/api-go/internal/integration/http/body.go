package http

import (
	"bytes"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// Request bodies read as Hono reads them: hono/body-limit, c.req.json() and c.req.parseBody().

// limited is hono/body-limit with maxSize and the integration routes' 413.
func limited(w http.ResponseWriter, r *http.Request, max int64) bool {
	if httpx.WithinBodyLimit(r, max) {
		return true
	}
	httpx.WriteJSONText(w, http.StatusRequestEntityTooLarge, httpx.ErrorBody{Detail: httpx.BodyTooLargeDetail})
	return false
}

// sourceLimit is sourceRequestLimit's maxSize: 8 KiB on /system/intelligence/sources/* and
// /system/v4/media/*.
const sourceLimit = 8192

// RequestLimit is sourceRequestLimit of source-routes.ts as apps/api/src/app.ts installs it:
// before the project scope reads the body, so an oversize write answers 413 before any scope
// or role decision. Mounting it in internal/app's middleware list (next to geography's) makes
// the order identical; without it the routes still refuse the body, after those gates.
func RequestLimit() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if isSourcePath(r.URL.Path) && !limited(w, r, sourceLimit) {
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// isSourcePath matches Hono's '/system/intelligence/sources/*' and '/system/v4/media/*', which
// also match the bare prefix.
func isSourcePath(path string) bool {
	for _, prefix := range []string{"/system/intelligence/sources", "/system/v4/media"} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return true
		}
	}
	return false
}

// form is the text fields of an urlencoded or multipart body as Hono's parseBody() gives them to
// formPayload: the last value of each name wins, a file (or a name ending in "[]", which Hono
// collects into an array) drops the name, and the object keeps JavaScript's key order.
type form struct {
	order  []string
	values map[string]*string
}

func (f *form) set(name string, value *string) {
	if f.values == nil {
		f.values = map[string]*string{}
	}
	if _, seen := f.values[name]; !seen {
		f.order = append(f.order, name)
	}
	if strings.HasSuffix(name, "[]") {
		value = nil
	}
	f.values[name] = value
}

func (f *form) object() *records.Object {
	o := records.NewObject()
	for _, name := range f.order {
		if v := f.values[name]; v != nil {
			o.Set(name, *v)
		}
	}
	return o
}

var errForm = errors.New("integration: unreadable form")

// parseForm is parseBody() for an exact multipart/form-data or
// application/x-www-form-urlencoded media type; any other one gives {}.
func parseForm(contentType string, body []byte) (*records.Object, error) {
	mediaType := strings.ToLower(strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0]))
	var f form
	switch mediaType {
	case "application/x-www-form-urlencoded":
		parseURLEncoded(body, &f)
	case "multipart/form-data":
		if err := parseMultipart(contentType, body, &f); err != nil {
			return nil, err
		}
	}
	return f.object(), nil
}

// parseURLEncoded is the URL Standard's application/x-www-form-urlencoded parser.
func parseURLEncoded(body []byte, f *form) {
	for _, sequence := range bytes.Split(body, []byte("&")) {
		if len(sequence) == 0 {
			continue
		}
		name, value, _ := bytes.Cut(sequence, []byte("="))
		n, v := formText(name), formText(value)
		f.set(n, &v)
	}
}

// formText replaces '+' with a space, percent-decodes and decodes UTF-8 without dropping a BOM.
func formText(b []byte) string {
	b = bytes.ReplaceAll(b, []byte("+"), []byte(" "))
	var out []byte
	for i := 0; i < len(b); i++ {
		if b[i] == '%' && i+2 < len(b) && isHexByte(b[i+1]) && isHexByte(b[i+2]) {
			out = append(out, unhexByte(b[i+1])<<4|unhexByte(b[i+2]))
			i += 2
			continue
		}
		out = append(out, b[i])
	}
	if bytes.HasPrefix(out, []byte("\xef\xbb\xbf")) {
		return "\uFEFF" + records.DecodeUTF8(out[3:])
	}
	return records.DecodeUTF8(out)
}

func isHexByte(c byte) bool { return c >= '0' && c <= '9' || c|0x20 >= 'a' && c|0x20 <= 'f' }

func unhexByte(c byte) byte {
	if c <= '9' {
		return c - '0'
	}
	return c | 0x20 - 'a' + 10
}

// parseMultipart reads multipart/form-data as undici's FormData parser: a boundary is required,
// the body must end with the closing delimiter, a part with a filename is a file.
func parseMultipart(contentType string, body []byte, f *form) error {
	_, params, err := mime.ParseMediaType(contentType)
	boundary := params["boundary"]
	if err != nil || boundary == "" {
		return errForm
	}
	if !bytes.Contains(body, []byte("--"+boundary+"--")) {
		return errForm
	}
	reader := multipart.NewReader(bytes.NewReader(body), boundary)
	for {
		part, err := reader.NextRawPart()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return errForm
		}
		_, disposition, err := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
		if err != nil {
			return errForm
		}
		name, hasName := disposition["name"]
		if !hasName {
			return errForm
		}
		value, err := io.ReadAll(part)
		if err != nil {
			return errForm
		}
		if _, file := disposition["filename"]; file {
			f.set(name, nil)
			continue
		}
		text := records.DecodeUTF8(value)
		f.set(name, &text)
	}
}

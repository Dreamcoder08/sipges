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
)

// errFormBody is a body Hono's parseBody cannot read: validation.ts answers "Invalid form body".
var errFormBody = errors.New("invalid form body")

// parseFormBody is Hono's c.req.parseBody() as parseForm uses it: an urlencoded or multipart
// body (by the lower-cased media type) becomes its last value per name, files left out; any
// other media type reads as no fields.
func parseFormBody(r *http.Request) (jsValue, error) {
	empty := jsValue{kind: kindObject, fields: map[string]jsValue{}}
	contentType, _ := httpx.Header(r, "Content-Type")
	mediaType, _, _ := strings.Cut(contentType, ";")
	switch strings.ToLower(strings.TrimSpace(mediaType)) {
	case "application/x-www-form-urlencoded":
		body, err := io.ReadAll(r.Body)
		if err != nil {
			return empty, errFormBody
		}
		return urlencoded(body), nil
	case "multipart/form-data":
		return multipartForm(r.Body, contentType)
	}
	return empty, nil
}

// urlencoded is the WHATWG application/x-www-form-urlencoded parser (URLSearchParams): only
// '&' separates, '+' is a space, invalid percent escapes stay as written, and names and values
// are UTF-8 decoded with replacement.
func urlencoded(body []byte) jsValue {
	v := jsValue{kind: kindObject, fields: map[string]jsValue{}}
	for _, sequence := range bytes.Split(body, []byte("&")) {
		if len(sequence) == 0 {
			continue
		}
		name, value, _ := bytes.Cut(sequence, []byte("="))
		v.fields[formText(name)] = jsValue{kind: kindString, text: formText(value)}
	}
	return v
}

func formText(b []byte) string {
	out := make([]byte, 0, len(b))
	for i := 0; i < len(b); i++ {
		switch c := b[i]; {
		case c == '+':
			out = append(out, ' ')
		case c == '%' && i+2 < len(b) && isHex(b[i+1]) && isHex(b[i+2]):
			out = append(out, unhex(b[i+1])<<4|unhex(b[i+2]))
			i += 2
		default:
			out = append(out, c)
		}
	}
	return decodeUTF8(out, false)
}

func isHex(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

func unhex(c byte) byte {
	switch {
	case c >= 'a':
		return c - 'a' + 10
	case c >= 'A':
		return c - 'A' + 10
	}
	return c - '0'
}

// multipartForm reads a multipart body as undici's formData() does: a part with a filename
// is a file (left out by parseForm, yet it still replaces an earlier value of its name); a
// body that does not parse is errFormBody.
func multipartForm(body io.Reader, contentType string) (jsValue, error) {
	v := jsValue{kind: kindObject, fields: map[string]jsValue{}}
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil || params["boundary"] == "" {
		return v, errFormBody
	}
	data, err := io.ReadAll(body)
	// undici refuses a body without its closing delimiter, where Go's reader reads no parts.
	if err != nil || !bytes.Contains(data, []byte("--"+params["boundary"]+"--")) {
		return v, errFormBody
	}
	reader := multipart.NewReader(bytes.NewReader(data), params["boundary"])
	for {
		part, err := reader.NextRawPart()
		if errors.Is(err, io.EOF) {
			return v, nil
		}
		if err != nil {
			return v, errFormBody
		}
		_, disposition, err := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
		name, named := disposition["name"]
		if err != nil || !named {
			return v, errFormBody
		}
		data, err := io.ReadAll(part)
		if err != nil {
			return v, errFormBody
		}
		if _, file := disposition["filename"]; file {
			delete(v.fields, name)
			continue
		}
		v.fields[name] = jsValue{kind: kindString, text: decodeUTF8(data, false)}
	}
}

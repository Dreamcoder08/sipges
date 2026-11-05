package http

// FormEntry is one FormData entry as `c.req.parseBody()` reads it: text, or a file with its
// name and bytes.
type FormEntry struct {
	Name string
	File bool
	// Text is the value, or the file's name.
	Text string
	Data []byte
}

// ParseForm is the upload body as Hono's parseBody reads it on Node (parseForm, pinned by
// testdata/form.json). The document lab reads its uploads with it too, as the TypeScript
// document lab shares Hono's reader: ok=false when parseBody throws; an empty list when the
// media type is not a form one.
func ParseForm(contentType string, present bool, body []byte) ([]FormEntry, bool) {
	entries, ok := parseForm(contentType, present, body)
	out := make([]FormEntry, len(entries))
	for i, e := range entries {
		out[i] = FormEntry{Name: e.name, File: e.file, Text: e.text, Data: e.data}
	}
	return out, ok
}

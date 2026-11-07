package cli

import (
	"bytes"
	"fmt"
	"mime/multipart"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
)

// attachment is one file of a multipart form.
type attachment struct {
	field, filename string
	content         []byte
}

func readAttachments(attach keyValues) ([]attachment, error) {
	var files []attachment
	for _, name := range sortedNames(attach) {
		for _, path := range attach[name] {
			content, err := os.ReadFile(path) //nolint:gosec // the caller names their own file
			if err != nil {
				return nil, localError("read the file: %v", err)
			}
			files = append(files, attachment{name, filepath.Base(path), content})
		}
	}
	return files, nil
}

// multipartBody builds a form from text fields and files.
func multipartBody(fields keyValues, files []attachment) ([]byte, string, error) {
	var out bytes.Buffer
	form := multipart.NewWriter(&out)
	for _, name := range sortedNames(fields) {
		for _, value := range fields[name] {
			if err := form.WriteField(name, value); err != nil {
				return nil, "", localError("build the form: %v", err)
			}
		}
	}
	for _, file := range files {
		header := textproto.MIMEHeader{}
		header.Set("Content-Disposition", multipartDisposition(file.field, file.filename))
		header.Set("Content-Type", "application/octet-stream")
		part, err := form.CreatePart(header)
		if err != nil {
			return nil, "", localError("build the form: %v", err)
		}
		if _, err := part.Write(file.content); err != nil {
			return nil, "", localError("build the form: %v", err)
		}
	}
	if err := form.Close(); err != nil {
		return nil, "", localError("build the form: %v", err)
	}
	return out.Bytes(), form.FormDataContentType(), nil
}

var quoteEscaper = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\r", "", "\n", "")

func multipartDisposition(field, filename string) string {
	return fmt.Sprintf(`form-data; name="%s"; filename="%s"`, quoteEscaper.Replace(field), quoteEscaper.Replace(filename))
}

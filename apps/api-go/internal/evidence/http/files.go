package http

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// multipartSlack is MULTIPART_SLACK: overhead allowed on top of the file itself before the
// body is refused unread.
const multipartSlack = 64 * 1024

// Messages of evidence-routes.ts, word for word.
const (
	goneDetail      = "El archivo ya no está disponible en este almacenamiento"
	extensionDetail = "Tipo de archivo no permitido. Use PDF, Office, CSV, TXT o imágenes JPG/PNG/WEBP."
	// noExtractor answers a PDF preview while its text reader (pdf.js) is only in the
	// TypeScript API; DOCX is read with the document lab's reader (platform/doctext).
	noExtractorDetail = "La vista previa de PDF aún no está disponible en este servidor"
)

func tooLargeDetail(maxBytes int) string {
	return "El archivo supera el límite de " + strconv.Itoa(maxBytes/(1024*1024)) + " MB"
}

// uploadErrors is UPLOAD_ERRORS: status and detail of each refused upload.
func uploadErrors(kind application.UploadError, maxBytes int) (int, string) {
	switch kind {
	case application.UploadModule:
		return http.StatusBadRequest, "Módulo de vínculo no válido"
	case application.UploadError(domain.RejectExtension):
		return http.StatusUnsupportedMediaType, extensionDetail
	case application.UploadError(domain.RejectContentMismatch):
		return http.StatusUnsupportedMediaType, "El contenido del archivo no corresponde a su extensión"
	case application.UploadError(domain.RejectEmpty):
		return http.StatusBadRequest, "El archivo está vacío"
	case application.UploadError(domain.RejectTooLarge):
		return http.StatusRequestEntityTooLarge, tooLargeDetail(maxBytes)
	}
	return http.StatusNotFound, "No existe el registro al que se desea vincular el archivo"
}

// requestStore binds the metadata reads and the attach write to the request's tenant
// transaction, one transaction per call, as each store call of the TypeScript service is.
type requestFiles struct {
	r  *http.Request
	db database.Beginner
}

func (s requestFiles) Attach(_ context.Context, in application.AttachInput) (*domain.Attachment, error) {
	return tenancyhttp.WithRequestTenant(s.r, s.db, func(ctx context.Context, q database.Querier) (*domain.Attachment, error) {
		return infrastructure.Attach(ctx, q, in)
	})
}

func files(r *http.Request, deps Deps) application.Files {
	random := deps.RandomHex
	if random == nil {
		random = randomHex
	}
	text := deps.Text
	if text == nil {
		text = infrastructure.DocText{}
	}
	return application.Files{
		Store:          requestStore{r: r, db: deps.DB},
		Attacher:       requestFiles{r: r, db: deps.DB},
		Storage:        deps.Storage,
		Text:           text,
		Now:            deps.Now,
		RandomHex:      random,
		MaxUploadBytes: deps.MaxUploadBytes,
	}
}

// randomHex is randomHex of compose.ts: n lower-case hex characters from crypto/rand.
func randomHex(n int) (string, error) {
	b := make([]byte, (n+1)/2)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b)[:n], nil
}

type issue struct {
	Type string   `json:"type"`
	Loc  []string `json:"loc"`
	Msg  string   `json:"msg"`
}

func missingField(w http.ResponseWriter, field string) {
	writeJSON(w, http.StatusUnprocessableEntity, httpx.ErrorBody{Detail: []issue{{Type: "missing", Loc: []string{"body", field}, Msg: "Field required"}}})
}

// readLimited is Hono's bodyLimit: a Content-Length over max is refused unread; otherwise the
// body is read and refused as soon as it passes max.
func readLimited(r *http.Request, maxBytes int64) ([]byte, bool, error) {
	if r.ContentLength > maxBytes {
		return nil, false, nil
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBytes+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(body)) > maxBytes {
		return nil, false, nil
	}
	return body, true, nil
}

type uploadJSON struct {
	OK         bool           `json:"ok"`
	Attachment attachmentJSON `json:"attachment"`
}

func uploadHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, within, err := readLimited(r, int64(deps.MaxUploadBytes)+multipartSlack)
		if err != nil {
			// A body cut off mid-read is what Hono's parseBody reports as unreadable.
			writeJSON(w, http.StatusUnprocessableEntity, httpx.ErrorBody{Detail: []issue{{Type: "value_error", Loc: []string{"body"}, Msg: "Invalid form body"}}})
			return
		}
		if !within {
			writeJSON(w, http.StatusRequestEntityTooLarge, httpx.ErrorBody{Detail: tooLargeDetail(deps.MaxUploadBytes)})
			return
		}
		contentType, present := httpx.Header(r, "Content-Type")
		entries, ok := parseForm(contentType, present, body)
		if !ok {
			writeJSON(w, http.StatusUnprocessableEntity, httpx.ErrorBody{Detail: []issue{{Type: "value_error", Loc: []string{"body"}, Msg: "Invalid form body"}}})
			return
		}
		// convertFormDataToBodyData: the last entry of a name wins (names ending in [] become
		// lists, which are neither text nor a file).
		form := map[string]formEntry{}
		for _, e := range entries {
			if !strings.HasSuffix(e.name, "[]") {
				form[e.name] = e
			}
		}
		text := func(name string) *string {
			if e, ok := form[name]; ok && !e.file {
				return &e.text
			}
			return nil
		}
		file, ok := form["file"]
		if !ok || !file.file {
			missingField(w, "file")
			return
		}
		linkedModule := text("linked_module")
		if linkedModule == nil {
			missingField(w, "linked_module")
			return
		}
		linkedRecordID := text("linked_record_id")
		if linkedRecordID == nil {
			missingField(w, "linked_record_id")
			return
		}
		scope, ok := tenancyhttp.ScopeFrom(r.Context())
		if !ok {
			internalError(w, r, deps.Logger, "evidence upload failed")
			return
		}
		a, refused, err := files(r, deps).Upload(r.Context(), application.UploadInput{
			TenantID:       scope.TenantID(),
			ScopeProjectID: scope.ProjectID,
			FileName:       file.text,
			Data:           file.data,
			LinkedModule:   *linkedModule,
			LinkedRecordID: *linkedRecordID,
			DocumentType:   text("document_type"),
			Author:         text("author"),
			Verification:   text("verification"),
			Notes:          text("notes"),
		})
		switch {
		case err != nil:
			internalError(w, r, deps.Logger, "evidence upload failed")
		case refused != "":
			status, detail := uploadErrors(refused, deps.MaxUploadBytes)
			writeJSON(w, status, httpx.ErrorBody{Detail: detail})
		default:
			writeJSON(w, http.StatusOK, uploadJSON{OK: true, Attachment: toJSON(*a)})
		}
	}
}

// byteString is a header value as Hono hands it to Node: the Headers object trims HTTP
// whitespace and refuses NUL, CR, LF and characters past U+00FF (500), Node's writeHead
// refuses the other control characters (the TypeScript API's process fails there; this port
// answers 500), and each remaining character is sent as one Latin-1 byte.
func byteString(s string) (string, bool) {
	s = strings.Trim(s, "\t\n\r ")
	out := make([]byte, 0, len(s))
	for _, r := range s {
		if r > 0xff || r != '\t' && (r < 0x20 || r == 0x7f) {
			return "", false
		}
		out = append(out, byte(r)) //nolint:gosec // r <= 0xff, checked above
	}
	return string(out), true
}

func downloadHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a, data, found, err := files(r, deps).Download(r.Context(), httpx.PathParam(r, "id"))
		switch {
		case err != nil:
			internalError(w, r, deps.Logger, "evidence download failed")
			return
		case a == nil:
			writeJSON(w, http.StatusNotFound, notFound)
			return
		case !found:
			writeJSON(w, http.StatusGone, httpx.ErrorBody{Detail: goneDetail})
			return
		}
		contentType, okType := byteString(a.ContentType)
		// originalName is sanitized to [A-Za-z0-9._-] on upload; migrated names are checked here.
		disposition, okName := byteString(`attachment; filename="` + a.OriginalName + `"`)
		if !okType || !okName {
			internalError(w, r, deps.Logger, "evidence download header refused")
			return
		}
		h := w.Header()
		h.Set("Content-Type", contentType)
		h.Set("Content-Length", strconv.Itoa(len(data)))
		h.Set("Content-Disposition", disposition)
		w.WriteHeader(http.StatusOK)
		// Served as an attachment with the type detected at upload; the Worker in front adds
		// nosniff and the API's CSP (go-proxy.ts), as the TypeScript API does itself.
		_, _ = w.Write(data) //nolint:gosec // G705: stored evidence bytes, sent as an attachment
	}
}

type previewJSON struct {
	Kind       application.PreviewKind `json:"kind"`
	Attachment attachmentJSON          `json:"attachment"`
}

type previewTextJSON struct {
	Kind       application.PreviewKind `json:"kind"`
	Format     domain.PreviewFormat    `json:"format"`
	Pages      any                     `json:"pages"`
	Truncated  bool                    `json:"truncated"`
	Attachment attachmentJSON          `json:"attachment"`
}

func previewHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, err := files(r, deps).Preview(r.Context(), httpx.PathParam(r, "id"))
		switch {
		case errors.Is(err, application.ErrNoTextExtractor):
			writeJSON(w, http.StatusNotImplemented, httpx.ErrorBody{Detail: noExtractorDetail})
		case err != nil:
			internalError(w, r, deps.Logger, "evidence preview failed")
		case p.Kind == application.PreviewMissingMetadata:
			writeJSON(w, http.StatusNotFound, notFound)
		case p.Kind == application.PreviewMissingObject:
			writeJSON(w, http.StatusGone, httpx.ErrorBody{Detail: goneDetail})
		case p.Kind == application.PreviewText:
			writeJSON(w, http.StatusOK, previewTextJSON{Kind: p.Kind, Format: p.Format, Pages: p.Pages, Truncated: p.Truncated, Attachment: toJSON(*p.Attachment)})
		default:
			writeJSON(w, http.StatusOK, previewJSON{Kind: p.Kind, Attachment: toJSON(*p.Attachment)})
		}
	}
}

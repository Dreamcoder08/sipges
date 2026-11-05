// Package http serves the routes of apps/api/src/contexts/evidence/http/evidence-routes.ts with
// the same status, headers and JSON: the metadata reads (GET /system/uploads and
// GET /system/uploads/{id}) and the file routes (POST /system/uploads,
// GET /system/uploads/{id}/download and /preview, files.go). The session, Origin, project scope
// and role gate ran before (internal/app); every database step is one tenant transaction of the
// request (WithRequestTenant), so row-level security decides which records and attachments
// exist.
package http

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/infrastructure"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// Deps are what the composition root (internal/app) hands this context.
type Deps struct {
	DB     database.Beginner
	Logger *slog.Logger
	// Storage holds the file bytes (R2 through its S3 API, a local directory, or a fake).
	Storage application.ObjectStorage
	// MaxUploadBytes is SIPGES_MAX_UPLOAD_BYTES.
	MaxUploadBytes int
	// Text reads PDF and DOCX for the preview; nil answers 501 for those formats.
	Text application.TextExtractor
	// Now is the clock of new uploads; nil means time.Now.
	Now func() time.Time
	// RandomHex makes attachment ids and object keys; nil means crypto/rand.
	RandomHex func(n int) (string, error)
}

// Register adds the evidence routes to mux.
func Register(mux *http.ServeMux, deps Deps) {
	mux.HandleFunc("GET /system/uploads", listHandler(deps))
	mux.HandleFunc("GET /system/uploads/{id}", getHandler(deps))
	mux.HandleFunc("POST /system/uploads", uploadHandler(deps))
	mux.HandleFunc("GET /system/uploads/{id}/download", downloadHandler(deps))
	mux.HandleFunc("GET /system/uploads/{id}/preview", previewHandler(deps))
}

// requestStore is the SQL store bound to one request's tenant transaction.
type requestStore struct {
	r  *http.Request
	db database.Beginner
}

func (s requestStore) List(_ context.Context, f application.Filter) ([]domain.Attachment, error) {
	return tenancyhttp.WithRequestTenant(s.r, s.db, func(ctx context.Context, q database.Querier) ([]domain.Attachment, error) {
		return infrastructure.List(ctx, q, f)
	})
}

func (s requestStore) Get(_ context.Context, id string) (*domain.Attachment, error) {
	return tenancyhttp.WithRequestTenant(s.r, s.db, func(ctx context.Context, q database.Querier) (*domain.Attachment, error) {
		return infrastructure.Get(ctx, q, id)
	})
}

func service(r *http.Request, deps Deps) application.Service {
	return application.Service{Store: requestStore{r: r, db: deps.DB}}
}

// attachmentJSON is toJson of evidence-routes.ts (app.py _attachment_dict without the storage key).
type attachmentJSON struct {
	ID             string `json:"id"`
	OriginalName   string `json:"original_name"`
	ContentType    string `json:"content_type"`
	SizeBytes      int64  `json:"size_bytes"`
	SHA256         string `json:"sha256"`
	LinkedModule   string `json:"linked_module"`
	LinkedRecordID string `json:"linked_record_id"`
	DocumentType   string `json:"document_type"`
	Author         string `json:"author"`
	Verification   string `json:"verification"`
	Notes          string `json:"notes"`
	ProjectID      string `json:"project_id"`
	ProjectName    string `json:"project_name"`
	LegacyProjID   string `json:"Proyecto_ID"`
	LegacyProject  string `json:"Proyecto"`
	CreatedAt      string `json:"created_at"`
	DownloadURL    string `json:"download_url"`
}

func toJSON(a domain.Attachment) attachmentJSON {
	return attachmentJSON{
		ID: a.ID, OriginalName: a.OriginalName, ContentType: a.ContentType, SizeBytes: a.SizeBytes,
		SHA256: a.SHA256, LinkedModule: a.LinkedModule, LinkedRecordID: a.LinkedRecordID,
		DocumentType: a.DocumentType, Author: a.Author, Verification: a.Verification, Notes: a.Notes,
		ProjectID: a.ProjectID, ProjectName: a.ProjectName, LegacyProjID: a.ProjectID,
		LegacyProject: a.ProjectName, CreatedAt: isoSeconds(a.CreatedAt), DownloadURL: domain.DownloadURL(a.ID),
	}
}

// notFound is NOT_FOUND: the same answer for a missing id, another tenant's id and an
// attachment of a record the clearance cannot see.
var notFound = httpx.ErrorBody{Detail: "Archivo no encontrado"}

func listHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit, ok := parseIntQuery(w, r, "limit", 200)
		if !ok {
			return
		}
		rows, err := service(r, deps).List(r.Context(), application.ListQuery{
			LinkedModule:   query(r, "linked_module"),
			LinkedRecordID: query(r, "linked_record_id"),
			Q:              query(r, "q"),
			Limit:          limit,
		})
		if err != nil {
			internalError(w, r, deps.Logger, "evidence read failed")
			return
		}
		out := make([]attachmentJSON, 0, len(rows))
		for _, a := range rows {
			out = append(out, toJSON(a))
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func getHandler(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a, err := service(r, deps).Get(r.Context(), httpx.PathParam(r, "id"))
		switch {
		case err != nil:
			internalError(w, r, deps.Logger, "evidence read failed")
		case a == nil:
			writeJSON(w, http.StatusNotFound, notFound)
		default:
			writeJSON(w, http.StatusOK, toJSON(*a))
		}
	}
}

// query is `c.req.query(name) ?? null`.
func query(r *http.Request, name string) *string {
	v, ok := httpx.QueryParam(r, name)
	if !ok {
		return nil
	}
	return &v
}

// internalError is the TypeScript API's onError 500; only the event is logged, since driver
// errors may carry connection details.
func internalError(w http.ResponseWriter, r *http.Request, log *slog.Logger, event string) {
	if log != nil {
		log.LogAttrs(r.Context(), slog.LevelError, event,
			slog.String("request_id", httpx.RequestIDFrom(r.Context())))
	}
	httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
}

// writeJSON is Hono's c.json: the body as JSON.stringify writes it ('<', '>' and '&' as they
// are), without a trailing newline.
func writeJSON(w http.ResponseWriter, status int, v any) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(bytes.TrimSuffix(b.Bytes(), []byte("\n")))
}

type validationIssue struct {
	Type string `json:"type"`
	Loc  []any  `json:"loc"`
	Msg  string `json:"msg"`
}

// parseIntQuery is parseIntQuery of apps/api/src/platform/http/validation.ts (FastAPI
// `limit: int = N`): the fallback when the parameter is absent, a 422 when it does not match
// /^\s*[+-]?\d+\s*$/, else its value, saturated at the int64 bounds (JavaScript reads larger
// ones as huge numbers, which the service clamps the same way).
func parseIntQuery(w http.ResponseWriter, r *http.Request, name string, fallback int64) (int64, bool) {
	raw, present := httpx.QueryParam(r, name)
	if !present {
		return fallback, true
	}
	if value, ok := parseJSInt(strings.TrimFunc(raw, isJSSpace)); ok {
		return value, true
	}
	writeJSON(w, http.StatusUnprocessableEntity, httpx.ErrorBody{Detail: []validationIssue{{
		Type: "int_parsing",
		Loc:  []any{"query", name},
		Msg:  "Input should be a valid integer, unable to parse string as an integer",
	}}})
	return 0, false
}

// parseJSInt reads [+-]?\d+ with ASCII digits only, as JavaScript's \d.
func parseJSInt(s string) (int64, bool) {
	digits := strings.TrimLeft(s, "+-")
	if len(s)-len(digits) > 1 || digits == "" || strings.Trim(digits, "0123456789") != "" {
		return 0, false
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if errors.Is(err, strconv.ErrRange) {
		if strings.HasPrefix(s, "-") {
			return math.MinInt64, true
		}
		return math.MaxInt64, true
	}
	return v, err == nil
}

// isJSSpace is JavaScript's \s (WhiteSpace and LineTerminator).
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// isoSeconds is isoSeconds of apps/api/src/platform/http/time.ts: Date.toISOString without the
// fractional seconds, including its six-digit signed years outside 0000-9999.
func isoSeconds(t time.Time) string {
	t = t.UTC()
	year := fmt.Sprintf("%04d", t.Year())
	if t.Year() < 0 || t.Year() > 9999 {
		year = fmt.Sprintf("%+07d", t.Year())
	}
	return year + t.Format("-01-02T15:04:05") + "Z"
}

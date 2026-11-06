package http

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/documents/domain"
	identityhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/identity/http"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/doctext"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

// The rest of document-lab-routes.ts: reading, comparing and reporting on an upload (open to
// read-only roles, identity access-policy READ_ONLY_POSTS), importing review excerpts and
// deciding them (admin and analista). The session, project scope and role gate ran before.

// Lab is the document lab's use cases as the routes call them (application.Lab).
type Lab interface {
	UploadLimit() int
	ReportContentType() string
	Analyze(ctx context.Context, f application.DocumentFile, projectID string) (domain.DocumentAnalysis, application.ReadError)
	Report(ctx context.Context, f application.DocumentFile, projectID string) ([]byte, application.ReadError, error)
	Compare(ctx context.Context, a, b application.DocumentFile, projectID string) (application.Comparison, application.ReadError)
	ImportReview(ctx context.Context, tenantID string, batch application.ReviewBatch) (int, application.ImportError, error)
	Decide(ctx context.Context, tenantID, id, status, reviewer, note string) (application.DecisionResult, domain.DecisionError, error)
	DecideMany(ctx context.Context, tenantID string, in application.BulkInput) (application.BulkDecision, domain.DecisionError, error)
}

// LabService adapts application.Lab to Lab.
type LabService struct{ application.Lab }

// UploadLimit is maxUploadBytes.
func (s LabService) UploadLimit() int { return s.MaxUploadBytes }

// ReportContentType is the renderer's media type.
func (s LabService) ReportContentType() string { return s.Renderer.ContentType() }

// multipartSlack is MULTIPART_SLACK: multipart overhead allowed on top of the files before the
// body is refused unread.
const multipartSlack = 64 * 1024

type statusDetail struct {
	status int
	detail string
}

// analyzeErrors is ANALYZE_ERRORS.
var analyzeErrors = map[application.ReadError]statusDetail{
	application.ReadExtension:    {http.StatusUnsupportedMediaType, "Tipo de documento no compatible"},
	application.ReadTooLarge:     {http.StatusRequestEntityTooLarge, "Archivo demasiado grande"},
	application.ReadEmpty:        {http.StatusBadRequest, "Archivo vacío"},
	application.ReadTooManyPages: {http.StatusRequestEntityTooLarge, "El PDF supera 100 páginas"},
	application.ReadUnreadable:   {http.StatusUnprocessableEntity, "No se puede leer el documento"},
	application.ReadNoText:       {http.StatusUnprocessableEntity, "No se detectó texto extraíble. Los PDF escaneados requieren OCR externo."},
}

// compareErrors is COMPARE_ERRORS.
var compareErrors = map[application.ReadError]statusDetail{
	application.ReadExtension:    {http.StatusUnsupportedMediaType, "Formato no permitido"},
	application.ReadTooLarge:     {http.StatusRequestEntityTooLarge, "Tamaño inválido"},
	application.ReadEmpty:        {http.StatusRequestEntityTooLarge, "Tamaño inválido"},
	application.ReadTooManyPages: {http.StatusRequestEntityTooLarge, "El PDF supera 100 páginas"},
	application.ReadUnreadable:   {http.StatusUnprocessableEntity, "No se puede leer el documento"},
	application.ReadNoText:       {http.StatusUnprocessableEntity, "Documento sin texto extraíble"},
}

// importErrors is IMPORT_ERRORS.
var importErrors = map[application.ImportError]statusDetail{
	application.ImportSHA256:      {http.StatusUnprocessableEntity, "SHA256 inválido"},
	application.ImportTooMany:     {http.StatusRequestEntityTooLarge, "Máximo 75 hallazgos"},
	application.ImportInvalidText: {http.StatusUnprocessableEntity, "Texto con caracteres no permitidos"},
}

// decisionErrors is BULK_ERRORS (DECISION_ERRORS plus the bulk cap).
var decisionErrors = map[domain.DecisionError]statusDetail{
	domain.ErrStatus:       {http.StatusUnprocessableEntity, "Estado no permitido"},
	domain.ErrNoteRequired: {http.StatusUnprocessableEntity, "La corroboración requiere nota sobre evidencia contrastada"},
	domain.ErrMissing:      {http.StatusNotFound, "Hallazgo no encontrado"},
	domain.ErrInvalidText:  {http.StatusUnprocessableEntity, "Texto con caracteres no permitidos"},
	domain.ErrTooMany:      {http.StatusUnprocessableEntity, "Máximo 1000 hallazgos por solicitud"},
}

func (e statusDetail) write(w http.ResponseWriter) { httpx.WriteError(w, e.status, e.detail) }

func failed(w http.ResponseWriter, r *http.Request, log *slog.Logger, event string) {
	// Only the event: driver errors may carry connection details.
	if log != nil {
		log.LogAttrs(r.Context(), slog.LevelError, event, slog.String("request_id", httpx.RequestIDFrom(r.Context())))
	}
	httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
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
	return body, int64(len(body)) <= maxBytes, nil
}

var invalidForm = []issue{{Type: "value_error", Loc: []any{"body"}, Msg: "Invalid form body"}}

func missingField(w http.ResponseWriter, field string) {
	writeIssues(w, []issue{{Type: "missing", Loc: []any{"body", field}, Msg: "Field required"}})
}

// readForm is readForm of document-lab-routes.ts, after bodyLimit: every named file field is
// required, and a supplied `project_id` must be the scope's project (docs/adr/0008 #6).
func readForm(w http.ResponseWriter, r *http.Request, limit int64, tooLarge string, fields ...string) (map[string]application.DocumentFile, string, bool) {
	body, within, err := readLimited(r, limit)
	if err != nil {
		writeIssues(w, invalidForm) // a body cut off mid-read: parseBody throws
		return nil, "", false
	}
	if !within {
		httpx.WriteError(w, http.StatusRequestEntityTooLarge, tooLarge)
		return nil, "", false
	}
	contentType, present := httpx.Header(r, "Content-Type")
	entries, ok := httpx.ParseForm(contentType, present, body)
	if !ok {
		writeIssues(w, invalidForm)
		return nil, "", false
	}
	// convertFormDataToBodyData: the last entry of a name wins; names ending in [] become
	// lists under that name, which are neither text nor a file.
	form := map[string]httpx.FormEntry{}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name, "[]") {
			form[e.Name] = e
		}
	}
	scope, ok := tenancyhttp.ScopeFrom(r.Context())
	if !ok {
		httpx.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return nil, "", false
	}
	if supplied, ok := form["project_id"]; ok && !supplied.File && supplied.Text != "" && supplied.Text != scope.ProjectID {
		httpx.WriteError(w, http.StatusForbidden, "Proyecto fuera de alcance")
		return nil, "", false
	}
	files := map[string]application.DocumentFile{}
	for _, field := range fields {
		e, ok := form[field]
		if !ok || !e.File {
			missingField(w, field)
			return nil, "", false
		}
		files[field] = application.DocumentFile{FileName: e.Text, Data: e.Data}
	}
	return files, scope.ProjectID, true
}

// Messages of the success answers, word for word.
const importedMessage = "Sólo se guardaron extractos de revisión, no los archivos originales."

type importJSON struct {
	OK       bool   `json:"ok"`
	NewItems int    `json:"new_items"`
	Message  string `json:"message"`
}

type decisionJSON struct {
	OK     bool                      `json:"ok"`
	ID     string                    `json:"id"`
	Status string                    `json:"status"`
	Record *application.RecordResult `json:"record"`
}

type bulkJSON struct {
	OK             bool                     `json:"ok"`
	DryRun         bool                     `json:"dry_run"`
	Decided        int                      `json:"decided"`
	Skipped        int                      `json:"skipped"`
	Remaining      int                      `json:"remaining"`
	Modules        []application.BulkModule `json:"modules"`
	Problems       []string                 `json:"problems"`
	RecordsCreated int                      `json:"records_created"`
}

// text is a body string as Node sends it to PostgreSQL: a lone surrogate becomes U+FFFD.
// Known divergence: the single decision echoes its id, which TypeScript writes with the lone
// surrogate escaped ("\ud800") and this port with U+FFFD.
func text(s string) string { return records.WellFormed(s) }

func optionalText(s *string) *string {
	if s == nil {
		return nil
	}
	t := text(*s)
	return &t
}

// LabRoutes registers the document lab's upload and write routes on mux.
func LabRoutes(mux *http.ServeMux, lab Lab, log *slog.Logger) {
	oneFile := int64(lab.UploadLimit()) + multipartSlack
	twoFiles := 2*int64(lab.UploadLimit()) + multipartSlack

	mux.HandleFunc("POST /system/document-lab/analyze", func(w http.ResponseWriter, r *http.Request) {
		httpx.ExtendWriteDeadline(w, doctext.LongestRead)
		files, project, ok := readForm(w, r, oneFile, analyzeErrors[application.ReadTooLarge].detail, "file")
		if !ok {
			return
		}
		analysis, refused := lab.Analyze(r.Context(), files["file"], project)
		if refused != "" {
			analyzeErrors[refused].write(w)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, analysis)
	})

	mux.HandleFunc("POST /system/document-lab/report.docx", func(w http.ResponseWriter, r *http.Request) {
		httpx.ExtendWriteDeadline(w, doctext.LongestRead)
		files, project, ok := readForm(w, r, oneFile, analyzeErrors[application.ReadTooLarge].detail, "file")
		if !ok {
			return
		}
		out, refused, err := lab.Report(r.Context(), files["file"], project)
		switch {
		case err != nil:
			failed(w, r, log, "document lab report failed")
		case refused != "":
			analyzeErrors[refused].write(w)
		default:
			w.Header().Set("Content-Type", lab.ReportContentType())
			w.Header().Set("Content-Disposition", `attachment; filename="`+domain.LabReportFilename+`"`)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(out) //nolint:gosec // the renderer's DOCX bytes, sent with their own media type as an attachment
		}
	})

	mux.HandleFunc("POST /system/document-lab/compare", func(w http.ResponseWriter, r *http.Request) {
		httpx.ExtendWriteDeadline(w, 2*doctext.LongestRead)
		files, project, ok := readForm(w, r, twoFiles, compareErrors[application.ReadTooLarge].detail, "file_a", "file_b")
		if !ok {
			return
		}
		comparison, refused := lab.Compare(r.Context(), files["file_a"], files["file_b"], project)
		if refused != "" {
			compareErrors[refused].write(w)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, comparison)
	})

	mux.HandleFunc("POST /system/document-lab/review/import", func(w http.ResponseWriter, r *http.Request) {
		raw, ok := readJSON(w, r)
		if !ok {
			return
		}
		body, issues := parseBatch(raw)
		if issues != nil {
			writeIssues(w, issues)
			return
		}
		scope, ok := tenancyhttp.ScopeFrom(r.Context())
		if !ok {
			failed(w, r, log, "document review import failed")
			return
		}
		project := body.ProjectID
		if project == "" {
			project = scope.ProjectID
		}
		batch := application.ReviewBatch{ProjectID: text(project), Filename: text(body.Filename), SHA256: body.SHA256}
		for _, item := range body.Items {
			batch.Items = append(batch.Items, application.ImportText{
				Tema: text(asText(item, "tema")), Fragmento: text(asText(item, "fragmento")),
				Ubicacion: text(asText(item, "ubicacion")), AccionSugerida: text(asText(item, "accion_sugerida")),
			})
		}
		n, refused, err := lab.ImportReview(r.Context(), scope.TenantID(), batch)
		switch {
		case err != nil:
			failed(w, r, log, "document review import failed")
		case refused != "":
			importErrors[refused].write(w)
		default:
			httpx.WriteJSON(w, http.StatusOK, importJSON{OK: true, NewItems: n, Message: importedMessage})
		}
	})

	mux.HandleFunc("POST /system/document-lab/review/bulk", func(w http.ResponseWriter, r *http.Request) {
		raw, ok := readJSON(w, r)
		if !ok {
			return
		}
		body, issues := parseBulk(raw)
		if issues != nil {
			writeIssues(w, issues)
			return
		}
		scope, okScope := tenancyhttp.ScopeFrom(r.Context())
		principal, okPrincipal := identityhttp.PrincipalFrom(r.Context())
		if !okScope || !okPrincipal {
			failed(w, r, log, "document review bulk decision failed")
			return
		}
		// The acting user, as the inbox fills `reviewer` for a single decision.
		reviewer := principal.FullName
		if reviewer == "" {
			reviewer = principal.Username
		}
		var ids []string
		if body.IDs != nil {
			ids = make([]string, len(body.IDs))
			for i, id := range body.IDs {
				ids[i] = text(id)
			}
		}
		result, refused, err := lab.DecideMany(r.Context(), scope.TenantID(), application.BulkInput{
			ProjectID: scope.ProjectID, IDs: ids, Theme: optionalText(body.Theme), SourceSHA256: body.SourceSHA256,
			Status: body.Status, Reviewer: reviewer, Note: text(body.Note), DryRun: body.DryRun,
		})
		switch {
		case err != nil:
			failed(w, r, log, "document review bulk decision failed")
		case refused != "":
			decisionErrors[refused].write(w)
		default:
			httpx.WriteJSON(w, http.StatusOK, bulkJSON{
				OK: true, DryRun: body.DryRun, Decided: result.Decided, Skipped: result.Skipped,
				Remaining: result.Remaining, Modules: result.Modules, Problems: result.Problems,
				RecordsCreated: result.RecordsCreated,
			})
		}
	})

	mux.HandleFunc("PATCH /system/document-lab/review/{id}", func(w http.ResponseWriter, r *http.Request) {
		raw, ok := readJSON(w, r)
		if !ok {
			return
		}
		body, issues := parseDecision(raw)
		if issues != nil {
			writeIssues(w, issues)
			return
		}
		scope, ok := tenancyhttp.ScopeFrom(r.Context())
		if !ok {
			failed(w, r, log, "document review decision failed")
			return
		}
		result, refused, err := lab.Decide(r.Context(), scope.TenantID(), text(httpx.PathParam(r, "id")),
			body.Status, text(body.Reviewer), text(body.Note))
		switch {
		case err != nil:
			failed(w, r, log, "document review decision failed")
		case refused != "":
			decisionErrors[refused].write(w)
		default:
			httpx.WriteJSON(w, http.StatusOK, decisionJSON{OK: true, ID: result.ID, Status: result.Status, Record: result.Record})
		}
	})
}

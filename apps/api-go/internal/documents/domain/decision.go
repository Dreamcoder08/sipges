//nolint:misspell // Spanish themes, fields and messages, verbatim from the TypeScript API.
package domain

import (
	"strings"

	kernel "github.com/Dreamcoder08/sipges/apps/api-go/internal/management/domain"
	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// The decision rules of review.ts and the record an approval writes (review-records.ts).

// Review statuses (REVIEW_STATUSES).
const (
	StatusPending      = "pendiente"
	StatusAccepted     = "aceptado_para_revision"
	StatusDiscarded    = "descartado"
	StatusCorroborated = "corroborado_documentalmente"
)

// IsReviewStatus is isReviewStatus.
func IsReviewStatus(s string) bool {
	switch s {
	case StatusPending, StatusAccepted, StatusDiscarded, StatusCorroborated:
		return true
	}
	return false
}

// Batch and request limits of review.ts.
const (
	MaxReviewImport = 75
	// MaxBulkDecision items at most per bulk request, decided in transactions of BulkBatch.
	MaxBulkDecision = 1000
	BulkBatch       = 200
)

// Code point limits of REVIEW_LIMITS.
const (
	LimitProjectID  = 120
	LimitSourceFile = 200
	LimitLocation   = 140
	LimitTheme      = 140
	LimitExcerpt    = 480
	LimitAction     = 500
	LimitReviewer   = 120
	LimitNote       = 1500
)

// DecisionError is the kind of a refused decision (ReviewDecisionError, plus the bulk cap).
type DecisionError string

// The kinds of DecisionError.
const (
	ErrStatus       DecisionError = "status"
	ErrNoteRequired DecisionError = "note_required"
	ErrMissing      DecisionError = "missing"
	ErrInvalidText  DecisionError = "invalid_text"
	ErrTooMany      DecisionError = "too_many"
)

// CheckDecision is checkDecision: a known status, and corroboration names its evidence.
func CheckDecision(status, note string) DecisionError {
	if !IsReviewStatus(status) {
		return ErrStatus
	}
	if status == StatusCorroborated && js.TrimJS(note) == "" {
		return ErrNoteRequired
	}
	return ""
}

// ProjectOf is projectOf: the project of a `COMPANY/PROJECT` tenant id.
func ProjectOf(tenantID string) string {
	return tenantID[strings.IndexByte(tenantID, '/')+1:]
}

// ReviewSource is REVIEW_SOURCE, the audit source of records created from approvals.
const ReviewSource = "la bandeja de revisión documental"

var statusLabels = map[string]string{
	StatusPending:      "pendiente",
	StatusAccepted:     "aceptado para revisión",
	StatusDiscarded:    "descartado",
	StatusCorroborated: "corroborado documentalmente",
}

// Field is one key and value of a record payload, in insertion order.
type Field struct {
	Key   string
	Value string
}

// ReviewRecordFields is reviewRecordFields: the record of an approved item, derived only from
// the item, in the key order of `{ ...own, ...common, Observaciones }`.
func ReviewRecordFields(item ReviewItem, projectID string) []Field {
	target := ReviewTargetFor(item.Theme)
	id := ReviewRecordID(item.ID)
	date := kernel.LimaToday(item.UpdatedAt)
	reviewer := ""
	if item.Reviewer != "" {
		reviewer = " por " + item.Reviewer
	}
	notes := []string{"Hallazgo documental " + statusLabels[item.Status] + reviewer + "."}
	if item.Theme != "" {
		notes = append(notes, "Tema: "+item.Theme+".")
	}
	if item.Action != "" {
		notes = append(notes, "Acción sugerida: "+item.Action)
	}
	if item.Note != "" {
		notes = append(notes, "Nota de revisión: "+item.Note)
	}
	notes = append(notes, "Documento: "+item.SourceFile+" (SHA-256 "+item.SourceSHA256+"), "+item.Location+".")
	corroborated := item.Status == StatusCorroborated
	var own []Field
	switch target.Module {
	case "actores":
		own = []Field{
			{"ID_Actor", id},
			{"Nombre_Actor/Organizacion", "Por identificar (" + item.SourceFile + ")"},
			{"Tipo_Actor", "Otro / por verificar"},
			{"Rol/Relacion", item.Excerpt},
		}
	case "demandas":
		own = []Field{
			{"ID_Demanda", id}, {"Fecha_Registro", date}, {"Tema", item.Theme},
			{"Descripcion", item.Excerpt}, {"Estado", "En revisión"},
		}
	case "compromisos":
		own = []Field{{"ID_Compromiso", id}, {"Fecha", date}, {"Descripcion", item.Excerpt}, {"Estado", "Pendiente"}}
	case "dialogos":
		own = []Field{{"Proceso", item.Excerpt}, {"Tema", item.Theme}, {"Estado", "Por verificar"}}
	case "oportunidades":
		own = []Field{{"Oportunidad", item.Excerpt}, {"Estado", "En evaluación"}}
	case "narrativas":
		level := "E - No verificada"
		if corroborated {
			level = "B - Corroborada"
		}
		own = []Field{
			{"ID_Narrativa", id}, {"Fecha_Observacion", date}, {"Plataforma/Fuente", item.SourceFile},
			{"Tema", item.Theme}, {"Categoria", "E - Ambiental-territorial"}, {"Descripcion", item.Excerpt},
			{"Tono", "Por evaluar"}, {"Nivel_Verificacion", level},
		}
	default:
		state := "pendiente"
		if corroborated {
			state = "validado"
		}
		own = []Field{{"Asunto", item.Excerpt}, {"Accion_Verificacion", item.Action}, {"Estado", state}}
	}
	return append(own,
		Field{"Proyecto_ID", projectID},
		Field{"Fuente_ID", item.SourceFile + " · " + item.Location},
		Field{"Revision_Documental_ID", item.ID},
		Field{"Observaciones", strings.Join(notes, " ")},
	)
}

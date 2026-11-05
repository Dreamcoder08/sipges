package http

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/application"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/domain"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/httpx"
	tenancyhttp "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/http"
)

const (
	defaultSourceType = "Publicación digital"
	alertNotice       = "La puntuación es prioridad de revisión, no riesgo social cuantificado."
	maxTerritory      = 500
)

// alertBody is AlertBody of intelligence-routes.ts.
var alertBody = append(append([]field{}, semanticBody...),
	field{name: "source_type", optional: true},
	field{name: "analyst_note", optional: true},
	field{name: "territory", optional: true, nullable: true, maxCodePoints: maxTerritory},
)

type alertCreatedJSON struct {
	ID           string          `json:"id"`
	Status       string          `json:"status"`
	Outcome      string          `json:"outcome"`
	Territory    *string         `json:"territory"`
	SourceRecord json.RawMessage `json:"source_record"` // nil is null
	Analysis     json.RawMessage `json:"analysis"`
	IRSAModified bool            `json:"irsa_modified"`
	Notice       string          `json:"notice"`
}

// AlertRoute registers POST /system/intelligence/territorial-alerts. Session, Origin, project
// scope (with the body's project check) and role gate ran before (internal/app).
func AlertRoute(mux *http.ServeMux, creation application.AlertCreation, log *slog.Logger) {
	mux.HandleFunc("POST /system/intelligence/territorial-alerts", func(w http.ResponseWriter, r *http.Request) {
		b, ok := parseBody(w, r, alertBody)
		if !ok {
			return
		}
		scope, ok := tenancyhttp.ScopeFrom(r.Context())
		if !ok {
			fail(w, r, log, tenancyhttp.ErrNoScope)
			return
		}
		input := application.AlertInput{
			Text: b.str("text"), SourceURL: b.str("source_url"), AnalystNote: b.str("analyst_note"),
			Mode: domain.ModeAutomatic, SourceType: defaultSourceType,
		}
		if _, sent := b["mode"]; sent {
			input.Mode = b.str("mode")
		}
		if _, sent := b["source_type"]; sent {
			input.SourceType = b.str("source_type")
		}
		if raw, sent := b["territory"]; sent && jsonType(raw) == "string" {
			territory := b.str("territory")
			input.Territory = &territory
		}
		created, kind, err := creation.Create(r.Context(), scope, input)
		if err != nil {
			fail(w, r, log, err)
			return
		}
		if e, known := textErrors[kind]; known {
			writeJSON(w, e.status, httpx.ErrorBody{Detail: e.detail})
			return
		}
		if e, known := semanticErrors[kind]; known {
			writeJSON(w, e.status, httpx.ErrorBody{Detail: e.detail})
			return
		}
		writeJSON(w, http.StatusOK, alertCreatedJSON{
			ID: created.Alert.ID, Status: created.Alert.Status, Outcome: created.Outcome,
			Territory: created.Alert.Territory, SourceRecord: created.Alert.SourceRecord,
			Analysis: created.Analysis, Notice: alertNotice,
		})
	})
}

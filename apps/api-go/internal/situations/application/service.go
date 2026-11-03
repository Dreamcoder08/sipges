// Package application holds the read use cases of apps/api/src/contexts/situations/application:
// the project settings with their catalogue, and the situations report, in the JSON shape of
// situations-routes.ts.
//
//nolint:misspell // Spanish record fields, modules and messages, verbatim from the TypeScript API.
package application

import (
	"context"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/database"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// Store reads a tenant's settings row and records inside its tenant transaction (row-level
// security applies; a read-only account never sees records marked 'restringido').
type Store interface {
	// Settings returns the project_settings row, nil when the project has none.
	Settings(ctx context.Context, q database.Querier, tenantID string) (*domain.Stored, error)
	// Records returns the records of modules, ordered by module, then id.
	Records(ctx context.Context, q database.Querier, tenantID string, modules []string) ([]domain.SourceRecord, error)
}

// lima is the calendar of Peru, where the projects are: a record dated today is never "in the
// future". Peru has kept UTC−5 without daylight saving since 1994, so a fixed zone needs no
// time zone database in the container.
var lima = time.FixedZone("America/Lima", -5*60*60)

// isoMillis is Date.prototype.toISOString.
func isoMillis(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// Method and Limitations are the report's fixed texts.
const Method = "Registros con fecha que comparten tema, actor o territorio registrado en la ventana del proyecto; cada registro pesa la mitad cada vida media y más si su prioridad es alta."

// Limitations are the report's caveats.
var Limitations = []string{
	"Agrupación por reglas sobre registros documentados: orienta la revisión, no predice conflictos.",
	"El territorio sale solo de los campos registrados; los registros sin fecha no forman situaciones.",
	"Las recomendaciones orientan; la decisión y la alerta las confirma siempre una persona.",
	"No modifica el IRSA. Umbrales y significados son preliminares y configurables.",
}

// PhaseJSON is one life-cycle phase with its saved weights and the suggestion.
type PhaseJSON struct {
	ID         string             `json:"id"`
	Label      string             `json:"label"`
	Weights    any                `json:"weights"`
	Suggestion map[string]float64 `json:"suggestion"`
}

// ExternalAI is the «Envío a IA externa» switch.
type ExternalAI struct {
	Enabled bool `json:"enabled"`
}

// SettingsJSON is GET /system/v4/settings.
type SettingsJSON struct {
	LevelMeanings   map[string]any          `json:"level_meanings"`
	WindowDays      any                     `json:"window_days"`
	HalfLifeDays    any                     `json:"half_life_days"`
	Thresholds      map[string]any          `json:"thresholds"`
	Recommendations []domain.CatalogueEntry `json:"recommendations"`
	Phase           any                     `json:"phase"`
	Phases          []PhaseJSON             `json:"phases"`
	ExternalAI      ExternalAI              `json:"external_ai"`
	Location        any                     `json:"location"`
	UpdatedBy       string                  `json:"updated_by"`
	UpdatedAt       *string                 `json:"updated_at"`
}

// Settings is settingsJson of situations-routes.ts over the stored row (nil: none).
func Settings(stored *domain.Stored) SettingsJSON {
	s := domain.WithDefaults(stored)
	phases := make([]PhaseJSON, 0, len(domain.Phases))
	for _, id := range domain.Phases {
		phases = append(phases, PhaseJSON{
			ID: id, Label: domain.PhaseLabels[id], Weights: s.PhaseWeights[id],
			Suggestion: domain.PhaseWeightSuggestions[id],
		})
	}
	out := SettingsJSON{
		LevelMeanings: s.LevelMeanings, WindowDays: s.WindowDays, HalfLifeDays: s.HalfLifeDays,
		Thresholds: s.Thresholds, Recommendations: domain.Catalogue(s), Phase: s.Phase, Phases: phases,
		ExternalAI: ExternalAI{s.ExternalAIEnabled}, Location: s.Location, UpdatedBy: s.UpdatedBy,
	}
	if s.UpdatedAt != nil {
		at := isoMillis(*s.UpdatedAt)
		out.UpdatedAt = &at
	}
	return out
}

// SituationsJSON is GET /system/v4/situations.
type SituationsJSON struct {
	GeneratedAt string                   `json:"generated_at"`
	Today       string                   `json:"today"`
	WindowDays  any                      `json:"window_days"`
	Considered  int                      `json:"considered"`
	Undated     int                      `json:"undated"`
	Situations  []domain.Situation       `json:"situations"`
	Narratives  domain.NarrativeOverview `json:"narratives"`
	Method      string                   `json:"method"`
	Limitations []string                 `json:"limitations"`
}

// Situations is the situations use case at now, over the stored row and the records of
// domain.Modules (lessons included).
func Situations(stored *domain.Stored, records []domain.SourceRecord, now time.Time) SituationsJSON {
	settings := domain.WithDefaults(stored)
	today := now.In(lima).Format(time.DateOnly)
	report := domain.FindSituations(records, settings, today)
	return SituationsJSON{
		GeneratedAt: isoMillis(now),
		Today:       today,
		WindowDays:  settings.WindowDays,
		Considered:  report.Considered,
		Undated:     report.Undated,
		Situations:  report.Situations,
		Narratives:  report.Narratives,
		Method:      Method,
		Limitations: Limitations,
	}
}

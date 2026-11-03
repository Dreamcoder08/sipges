// Package domain is the Go port of apps/api/src/contexts/situations/domain: project settings,
// records as dated signals, and situations (docs/adr/0020). Pure: no I/O. Stored values are kept
// as decoded JSON so that whatever the TypeScript API saved reads back the same.
//
//nolint:misspell // Spanish record fields, modules and messages, verbatim from the TypeScript API.
package domain

import "time"

// Levels in rising order.
var Levels = []string{"Verde", "Amarillo", "Naranja", "Rojo"}

// Phases of a project's life cycle (docs/adr/0021 §4).
var Phases = []string{"exploracion", "construccion", "operacion", "cierre"}

// PhaseLabels are the phases' display names.
var PhaseLabels = map[string]string{
	"exploracion":  "Exploración",
	"construccion": "Construcción",
	"operacion":    "Operación",
	"cierre":       "Cierre",
}

// PhaseWeightSuggestions are the preliminary IRSA weights per phase, never applied on their own.
var PhaseWeightSuggestions = map[string]map[string]float64{
	"exploracion":  {"G": 0.2, "A": 0.25, "D": 0.15, "N": 0.2, "E": 0.1, "I": 0.1},
	"construccion": {"G": 0.15, "A": 0.15, "D": 0.25, "N": 0.15, "E": 0.2, "I": 0.1},
	"operacion":    {"G": 0.15, "A": 0.15, "D": 0.2, "N": 0.15, "E": 0.25, "I": 0.1},
	"cierre":       {"G": 0.15, "A": 0.1, "D": 0.25, "N": 0.1, "E": 0.25, "I": 0.15},
}

var defaultLevelMeanings = map[string]any{
	"Verde":    "Situación estable / riesgo bajo",
	"Amarillo": "Requiere atención y seguimiento",
	"Naranja":  "Requiere intervención preventiva",
	"Rojo":     "Situación crítica / atención inmediata",
}

// Default numbers of DEFAULT_SETTINGS.
const (
	DefaultWindowDays   = 90
	DefaultHalfLifeDays = 14
)

func defaultThresholds() map[string]any {
	return map[string]any{"Amarillo": float64(2), "Naranja": float64(4), "Rojo": float64(7)}
}

// Settings is ProjectSettings after withDefaults. Values the TypeScript API stores as given (window,
// half-life, phase, weights, location) stay decoded JSON (json.Number numbers, nil for null).
type Settings struct {
	LevelMeanings     map[string]any
	WindowDays        any
	HalfLifeDays      any
	Thresholds        map[string]any
	Recommendations   map[string]any
	Phase             any
	PhaseWeights      map[string]any
	ExternalAIEnabled bool
	Location          any
	UpdatedBy         string
	UpdatedAt         *time.Time
}

// Stored is a project_settings row: the settings object as decoded JSON, and its columns.
type Stored struct {
	Settings  map[string]any
	UpdatedBy string
	UpdatedAt time.Time
}

// spread is {...value} for a decoded JSON object; the TypeScript API only stores objects there.
func spread(into map[string]any, value any) map[string]any {
	if m, ok := value.(map[string]any); ok {
		for k, v := range m {
			into[k] = v
		}
	}
	return into
}

// orDefault is value ?? fallback.
func orDefault(m map[string]any, key string, fallback any) any {
	if v, ok := m[key]; ok && v != nil {
		return v
	}
	return fallback
}

// WithDefaults is withDefaults of settings.ts over the row the store loaded (nil: no row).
func WithDefaults(stored *Stored) Settings {
	var s map[string]any
	if stored != nil {
		s = stored.Settings
	}
	out := Settings{
		WindowDays:      orDefault(s, "windowDays", float64(DefaultWindowDays)),
		HalfLifeDays:    orDefault(s, "halfLifeDays", float64(DefaultHalfLifeDays)),
		LevelMeanings:   spread(spread(map[string]any{}, defaultLevelMeanings), s["levelMeanings"]),
		Thresholds:      spread(defaultThresholds(), s["thresholds"]),
		Recommendations: spread(map[string]any{}, s["recommendations"]),
		Phase:           orDefault(s, "phase", nil),
		PhaseWeights:    spread(map[string]any{}, s["phaseWeights"]),
		Location:        orDefault(s, "location", nil),
	}
	if ai, ok := s["externalAi"].(map[string]any); ok {
		out.ExternalAIEnabled = ai["enabled"] == true
	}
	if stored != nil {
		// The row's columns, as the store spreads them over the stored object.
		at := stored.UpdatedAt
		out.UpdatedBy, out.UpdatedAt = stored.UpdatedBy, &at
	}
	return out
}

// RecommendationIDs is the fixed catalogue of conditions (§3), in display order.
var RecommendationIDs = []string{
	"verificar", "seguimiento", "contactar", "reunion", "monitoreo", "narrativas", "buzon", "inmediata",
}

// DefaultRecommendations are the catalogue's texts until a project rewords them.
var DefaultRecommendations = map[string]string{
	"verificar":   "Verificar la información con las fuentes y el equipo de campo antes de escalar.",
	"seguimiento": "Hacer seguimiento a la demanda o compromiso relacionado y documentar la respuesta.",
	"contactar":   "Contactar a {actores} para conocer su posición.",
	"reunion":     "Coordinar una reunión con los actores involucrados.",
	"monitoreo":   "Aumentar la frecuencia de monitoreo de este tema.",
	"narrativas":  "Contrastar las publicaciones con fuentes independientes antes de responder.",
	"buzon":       "Responder los casos del buzón relacionados dentro del plazo.",
	"inmediata":   "Escalar al responsable del proyecto y activar la atención inmediata.",
}

// RecommendationConditions describe when each recommendation applies.
var RecommendationConditions = map[string]string{
	"verificar":   "Siempre",
	"seguimiento": "Hay demandas o compromisos",
	"contactar":   "Hay actores y el nivel es Amarillo o superior",
	"reunion":     "Nivel Naranja o Rojo",
	"monitoreo":   "La situación está en aumento",
	"narrativas":  "Hay publicaciones o narrativas",
	"buzon":       "Hay casos del buzón",
	"inmediata":   "Nivel Rojo",
}

// CatalogueEntry is one condition with the project's wording or the default.
type CatalogueEntry struct {
	ID        string `json:"id"`
	Condition string `json:"condition"`
	Text      any    `json:"text"`
	Custom    bool   `json:"custom"`
}

// Catalogue is recommendationCatalogue of the situations service.
func Catalogue(s Settings) []CatalogueEntry {
	out := make([]CatalogueEntry, 0, len(RecommendationIDs))
	for _, id := range RecommendationIDs {
		v, custom := s.Recommendations[id]
		text := v
		if v == nil {
			text = DefaultRecommendations[id]
		}
		out = append(out, CatalogueEntry{ID: id, Condition: RecommendationConditions[id], Text: text, Custom: custom})
	}
	return out
}

// texts is { ...DEFAULT_RECOMMENDATIONS, ...current.recommendations } as strings.
func texts(s Settings) map[string]string {
	out := make(map[string]string, len(DefaultRecommendations))
	for id, text := range DefaultRecommendations {
		out[id] = text
	}
	for id, v := range s.Recommendations {
		out[id] = JSString(v)
	}
	return out
}

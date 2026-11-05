package application

import (
	"context"
	"encoding/json"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/intelligence/domain"
	situations "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
	tenancy "github.com/Dreamcoder08/sipges/apps/api-go/internal/tenancy/domain"
)

const (
	defaultSourceType = "Publicación digital"
	narrativeModule   = "Narrativas" //nolint:misspell // the Spanish module name
	maxRecordID       = 200
	maxTerritory      = 500
	levelHigh         = "Alta"
	levelMedium       = "Media"
	outcomeIneligible = "ineligible"
)

// NarrativeInput is the input of evaluateNarrative. Payload reads a field of the record.
type NarrativeInput struct {
	ID           string
	Payload      func(key string) (any, bool)
	Marking      string
	MinimumLevel string
}

// NarrativeOutcome is what evaluateNarrative answers.
type NarrativeOutcome struct {
	Outcome string
	AlertID string
}

// EvaluateNarrative is evaluateNarrative of intelligence-service.ts: rules only, so a record's text
// never reaches a model, and only over the fields the record states. Restricted and unknown
// markings fail closed: they must never enter the broader digital inbox. An evaluation repeated
// after a retry finds the same source record and answers duplicate.
func (c AlertCreation) EvaluateNarrative(ctx context.Context, scope tenancy.Scope, input NarrativeInput) (NarrativeOutcome, error) {
	ineligible := NarrativeOutcome{Outcome: outcomeIneligible}
	if (input.Marking != "publico" && input.Marking != "interno") || input.ID == "" || situations.Len16(input.ID) > maxRecordID {
		return ineligible, nil
	}
	sourceType := defaultSourceType
	if value, ok := input.Payload("Tipo_Fuente"); ok && value != nil {
		text, isText := value.(string)
		if !isText {
			return ineligible, nil
		}
		sourceType = text
	}
	if !domain.IsSourceType(sourceType) {
		return ineligible, nil
	}
	text := textField(input.Payload, "Descripcion")
	sourceURL := domain.TrimJS(textField(input.Payload, "URL_Publicacion"))
	var territory *string
	if value, ok := input.Payload("Territorio"); ok {
		if place, isText := value.(string); isText {
			place = domain.TrimJS(place)
			territory = &place
		}
	}
	if territory != nil && situations.Len16(*territory) > maxTerritory {
		return ineligible, nil
	}
	analysis, kind, err := c.Semantic.Analyze(ctx, scope, text, sourceURL, domain.ModeRules)
	if err != nil {
		return NarrativeOutcome{}, err
	}
	if kind != "" {
		return ineligible, nil
	}
	var report reportFields
	if err := json.Unmarshal(analysis, &report); err != nil {
		return NarrativeOutcome{}, err
	}
	level := report.Orientation.Level
	if level != levelHigh && (input.MinimumLevel == levelHigh || level != levelMedium) {
		return ineligible, nil
	}
	created, kind, err := c.Create(ctx, scope, AlertInput{
		Text: text, SourceURL: sourceURL, Mode: domain.ModeRules, SourceType: sourceType, Territory: territory,
		SourceRecord: &SourceRecord{Module: narrativeModule, ID: input.ID},
	})
	if err != nil {
		return NarrativeOutcome{}, err
	}
	if kind != "" {
		return ineligible, nil
	}
	return NarrativeOutcome{Outcome: created.Outcome, AlertID: created.Alert.ID}, nil
}

func textField(payload func(string) (any, bool), key string) string {
	value, _ := payload(key)
	text, _ := value.(string)
	return text
}

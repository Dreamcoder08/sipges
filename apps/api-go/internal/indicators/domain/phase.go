package domain

import (
	"bytes"
	"encoding/json"
	"strconv"
)

// phaseLabels is PHASE_LABELS of apps/api/src/contexts/situations/domain/settings.ts.
//
//nolint:misspell // Spanish phase ids, verbatim from the TypeScript API.
var phaseLabels = map[string]string{
	"exploracion":  "Exploración",
	"construccion": "Construcción",
	"operacion":    "Operación",
	"cierre":       "Cierre",
}

// Phase is the project's current life-cycle phase with the IRSA weights saved for it
// (activePhaseWeights, docs/adr/0021 §4).
type Phase struct {
	ID string
	// Label is nil for a phase PHASE_LABELS does not name (JavaScript's undefined).
	Label *string
	// Weights are the saved weights as PostgreSQL wrote them.
	Weights json.RawMessage
}

// ActivePhase is activePhaseWeights over the stored settings: the current phase (`phase`, when a
// string) and the weights saved for it (`phaseWeights[phase]`), or false when IRSA keeps the
// general weights: no phase, or a falsy value saved for it.
func ActivePhase(phase *string, weights json.RawMessage) (Phase, bool) {
	if phase == nil || *phase == "" || falsy(weights) {
		return Phase{}, false
	}
	p := Phase{ID: *phase, Weights: weights}
	if label, ok := phaseLabels[*phase]; ok {
		p.Label = &label
	}
	return p, true
}

// falsy is JavaScript's falsiness for a JSON value; absent counts as undefined.
func falsy(v json.RawMessage) bool {
	v = bytes.TrimSpace(v)
	switch {
	case len(v) == 0, string(v) == "null", string(v) == "false", string(v) == `""`:
		return true
	case v[0] == '-' || (v[0] >= '0' && v[0] <= '9'):
		f, err := strconv.ParseFloat(string(v), 64)
		return err == nil && f == 0
	}
	return false
}

// Config is the IRSA configuration with the phase's weights: `{...cfg, weights: {...weights}}`.
func (p Phase) Config(cfg json.RawMessage) (json.RawMessage, error) {
	return AppendMember(cfg, "weights", p.Weights)
}

// Decorate is the IRSA result of indicators-service.ts for a phase: the result's keys, then
// `phase: {id, label}`, with the phase's note appended to `notes` in place.
func (p Phase) Decorate(result json.RawMessage) (json.RawMessage, error) {
	ms, err := members(result)
	if err != nil {
		return nil, err
	}
	label := "undefined"
	if p.Label != nil {
		label = *p.Label
	}
	note := "Pesos de la fase " + label + " del proyecto (SIPGES), preliminares hasta su validación."
	phase, err := Encode(struct {
		ID    string  `json:"id"`
		Label *string `json:"label,omitempty"`
	}{p.ID, p.Label})
	if err != nil {
		return nil, err
	}
	hasPhase := false
	for i := range ms {
		switch ms[i].key {
		case "notes":
			var notes []json.RawMessage
			if err := json.Unmarshal(ms[i].value, &notes); err != nil {
				return nil, err
			}
			ms[i].value, err = Encode(append(notes, mustString(note)))
			if err != nil {
				return nil, err
			}
		case "phase":
			ms[i].value, hasPhase = phase, true
		}
	}
	if !hasPhase {
		ms = append(ms, member{key: "phase", value: phase})
	}
	return writeObject(ms), nil
}

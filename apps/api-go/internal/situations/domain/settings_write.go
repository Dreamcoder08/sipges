package domain

import (
	"bytes"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/zod"
	records "github.com/Dreamcoder08/sipges/apps/api-go/internal/records/domain"
)

// The write side of the project settings: ProjectSettingsIn of packages/contracts/src/situations.ts,
// and withDefaults, applySettingsPatch and changedFields of settings.ts. Values here are the records
// context's JSON values, because changedFields compares JSON.stringify results, which read key
// order: the row comes back in jsonb's order and a saved phase in the schema's.

// Row is a project_settings row with the settings object in its stored key order.
type Row struct {
	Settings  *records.Object
	UpdatedBy string
	UpdatedAt time.Time
}

// SettingsPatch is ProjectSettingsPatch: Fields holds the fields sent, under their stored names,
// except PhaseWeights, which merges by phase (nil: a phase goes back to the general weights).
type SettingsPatch struct {
	Fields       *records.Object
	PhaseWeights *records.Object
}

var (
	meaningText        = zod.Str{Trim: true, Min: 1, Max: 120, NoNUL: true}
	recommendationText = zod.Str{Trim: true, Min: 1, Max: 300, NoNUL: true}
	placeText          = zod.Str{Trim: true, Min: 2, Max: 80, NoNUL: true}
	weightNumber       = zod.Num{Min: zod.Bound(0), Max: zod.Bound(1)}
	thresholdNumber    = zod.Num{Positive: true, Max: zod.Bound(1000)}
	longitude          = zod.Num{Min: zod.Bound(-180), Max: zod.Bound(180)}
	latitude           = zod.Num{Min: zod.Bound(-90), Max: zod.Bound(90)}
	dimensions         = []string{"G", "A", "D", "N", "E", "I"}
)

const (
	thresholdsMessage = "Los umbrales deben ser crecientes: Amarillo < Naranja < Rojo"
	weightsMessage    = "Los pesos de una fase deben sumar 1"
	extentMessage     = "El área debe ir de oeste a este y de sur a norte"
	weightsTolerance  = 0.02
)

func levelMeanings(v any) (any, zod.Issues) {
	var p zod.Issues
	o, ok := zod.Object(v, &p)
	if !ok {
		return nil, p
	}
	out := records.NewObject()
	for _, level := range Levels {
		text, child := meaningText.Parse(zod.Field(o, level))
		out.Set(level, text)
		p.Merge(level, child)
	}
	return out, p
}

func thresholds(v any) (any, zod.Issues) {
	var p zod.Issues
	o, ok := zod.Object(v, &p)
	if !ok {
		return nil, p
	}
	out := records.NewObject()
	values := make([]float64, 0, 3)
	for _, level := range Levels[1:] {
		value, child := thresholdNumber.Parse(zod.Field(o, level))
		out.Set(level, value)
		values = append(values, value)
		p.Merge(level, child)
	}
	if !p.Aborted() && !(values[0] < values[1] && values[1] < values[2]) {
		p.AddContinue("custom", thresholdsMessage)
	}
	return out, p
}

// partialRecord is z.partialRecord(z.enum(keys), value): keys in property order, then the ones
// outside the enum as one issue, which later checks survive.
func partialRecord(v any, keys []string, value func(any) (any, zod.Issues)) (any, zod.Issues) {
	var p zod.Issues
	o, ok := v.(*records.Object)
	if !ok {
		p.InvalidType("record", v)
		return nil, p
	}
	out := records.NewObject()
	var unknown []string
	for _, key := range o.Keys() {
		if key == "__proto__" {
			continue
		}
		if !slices.Contains(keys, key) {
			unknown = append(unknown, `"`+key+`"`)
			continue
		}
		parsed, child := value(zod.Field(o, key))
		out.Set(key, parsed)
		p.Merge(key, child)
	}
	if len(unknown) > 0 {
		noun := "Unrecognized key: "
		if len(unknown) > 1 {
			noun = "Unrecognized keys: "
		}
		p.AddContinue("unrecognized_keys", noun+strings.Join(unknown, ", "))
	}
	return out, p
}

func recommendation(v any) (any, zod.Issues) { return recommendationText.Parse(v) }

func phaseWeights(v any) (any, zod.Issues) {
	if v == nil {
		return nil, nil
	}
	var p zod.Issues
	o, ok := zod.Object(v, &p)
	if !ok {
		return nil, p
	}
	out := records.NewObject()
	sum := 0.0
	for _, key := range dimensions {
		value, child := weightNumber.Parse(zod.Field(o, key))
		out.Set(key, value)
		sum += value
		p.Merge(key, child)
	}
	if !p.Aborted() && math.Abs(sum-1) > weightsTolerance {
		p.AddContinue("custom", weightsMessage)
	}
	return out, p
}

// extent is the z.tuple of four coordinates: a wrong length reports only that.
func extent(v any) (any, zod.Issues) {
	var p zod.Issues
	list, ok := v.([]any)
	if !ok {
		p.InvalidType("tuple", v)
		return nil, p
	}
	if len(list) > 4 {
		p.Add("too_big", "Too big: expected array to have <=4 items")
		return nil, p
	}
	if len(list) < 4 {
		p.Add("too_small", "Too small: expected array to have >=4 items")
		return nil, p
	}
	out := make([]any, 4)
	numbers := make([]float64, 4)
	for i, schema := range []zod.Num{longitude, latitude, longitude, latitude} {
		value, child := schema.Parse(list[i])
		out[i], numbers[i] = value, value
		p.Merge(i, child)
	}
	if !p.Aborted() && !(numbers[0] < numbers[2] && numbers[1] < numbers[3]) {
		p.AddContinue("custom", extentMessage)
	}
	return out, p
}

func location(v any) (any, zod.Issues) {
	if v == nil {
		return nil, nil
	}
	var p zod.Issues
	o, ok := zod.Object(v, &p)
	if !ok {
		return nil, p
	}
	place, child := placeText.Parse(zod.Field(o, "place"))
	p.Merge("place", child)
	area, child := extent(zod.Field(o, "extent"))
	p.Merge("extent", child)
	out := records.NewObject()
	out.Set("place", place)
	out.Set("extent", area)
	return out, p
}

func externalAI(v any) (any, zod.Issues) {
	var p zod.Issues
	o, ok := zod.Object(v, &p)
	if !ok {
		return nil, p
	}
	enabled, child := zod.Bool(zod.Field(o, "enabled"))
	p.Merge("enabled", child)
	out := records.NewObject()
	out.Set("enabled", enabled)
	return out, p
}

func integer(lo, hi float64) func(any) (any, zod.Issues) {
	schema := zod.Num{Int: true, Min: zod.Bound(lo), Max: zod.Bound(hi)}
	return func(v any) (any, zod.Issues) { return schema.Parse(v) }
}

func phase(v any) (any, zod.Issues) {
	if v == nil {
		return nil, nil
	}
	return zod.Enum(v, Phases)
}

// ParseSettingsPatch is ProjectSettingsIn.safeParse; every field is optional, unknown keys drop.
func ParseSettingsPatch(body any) (SettingsPatch, []records.Issue) {
	var p zod.Issues
	o, ok := zod.Object(body, &p)
	if !ok {
		return SettingsPatch{}, zod.ToIssues(p, body)
	}
	patch := SettingsPatch{Fields: records.NewObject()}
	for _, f := range []struct {
		body, stored string
		schema       func(any) (any, zod.Issues)
	}{
		{"level_meanings", "levelMeanings", levelMeanings},
		{"window_days", "windowDays", integer(7, 365)},
		{"half_life_days", "halfLifeDays", integer(1, 180)},
		{"thresholds", "thresholds", thresholds},
		{"recommendations", "recommendations", func(v any) (any, zod.Issues) {
			return partialRecord(v, RecommendationIDs, recommendation)
		}},
		{"phase", "phase", phase},
		{"phase_weights", "phaseWeights", func(v any) (any, zod.Issues) {
			return partialRecord(v, Phases, phaseWeights)
		}},
		{"external_ai", "externalAi", externalAI},
		{"location", "location", location},
	} {
		v := zod.Field(o, f.body)
		if zod.IsUndefined(v) {
			continue
		}
		value, child := f.schema(v)
		p.Merge(f.body, child)
		if f.stored == "phaseWeights" {
			patch.PhaseWeights, _ = value.(*records.Object)
			continue
		}
		patch.Fields.Set(f.stored, value)
	}
	if len(p) > 0 {
		return SettingsPatch{}, zod.ToIssues(p, body)
	}
	return patch, nil
}

// spreadObject is {...value} for a decoded JSON object.
func spreadObject(into *records.Object, value any) *records.Object {
	if o, ok := value.(*records.Object); ok {
		for _, k := range o.Keys() {
			v, _ := o.Get(k)
			into.Set(k, v)
		}
	}
	return into
}

func orNil(o *records.Object, key string) any {
	if o == nil {
		return nil
	}
	v, _ := o.Get(key)
	return v
}

func orNumber(o *records.Object, key string, fallback float64) any {
	if v := orNil(o, key); v != nil {
		return v
	}
	return fallback
}

// CurrentSettings is withDefaults for a save: only the known fields, in JavaScript's key order.
func CurrentSettings(row *Row) *records.Object {
	var stored *records.Object
	if row != nil {
		stored = row.Settings
	}
	meanings, limits := records.NewObject(), records.NewObject()
	for _, level := range Levels {
		meanings.Set(level, defaultLevelMeanings[level])
	}
	for _, level := range Levels[1:] {
		limits.Set(level, defaultThresholds()[level])
	}
	enabled := false
	if ai, ok := orNil(stored, "externalAi").(*records.Object); ok {
		enabled = orNil(ai, "enabled") == true
	}
	ai := records.NewObject()
	ai.Set("enabled", enabled)
	out := records.NewObject()
	out.Set("windowDays", orNumber(stored, "windowDays", DefaultWindowDays))
	out.Set("halfLifeDays", orNumber(stored, "halfLifeDays", DefaultHalfLifeDays))
	out.Set("levelMeanings", spreadObject(meanings, orNil(stored, "levelMeanings")))
	out.Set("thresholds", spreadObject(limits, orNil(stored, "thresholds")))
	out.Set("recommendations", spreadObject(records.NewObject(), orNil(stored, "recommendations")))
	out.Set("phase", orNil(stored, "phase"))
	out.Set("phaseWeights", spreadObject(records.NewObject(), orNil(stored, "phaseWeights")))
	out.Set("externalAi", ai)
	out.Set("location", orNil(stored, "location"))
	return out
}

// ApplySettingsPatch is applySettingsPatch without its author and time: the sent fields replace
// the current ones and phase weights merge by phase, in the phases' order.
func ApplySettingsPatch(current *records.Object, patch SettingsPatch) *records.Object {
	after := current.Clone()
	for _, k := range patch.Fields.Keys() {
		v, _ := patch.Fields.Get(k)
		after.Set(k, v)
	}
	stored, _ := orNil(current, "phaseWeights").(*records.Object)
	merged := records.NewObject()
	for _, id := range Phases {
		weights := orNil(stored, id)
		if patch.PhaseWeights != nil {
			if sent, ok := patch.PhaseWeights.Get(id); ok {
				weights = sent
			}
		}
		if weights != nil {
			merged.Set(id, weights)
		}
	}
	after.Set("phaseWeights", merged)
	return after
}

// ChangedFields is changedFields: which fields differ as JSON.stringify writes them.
func ChangedFields(before, after *records.Object) []string {
	var fields []string
	for _, key := range []string{
		"levelMeanings", "windowDays", "halfLifeDays", "thresholds", "recommendations", "phase",
		"phaseWeights", "externalAi", "location",
	} {
		if !bytes.Equal(records.Stringify(orNil(before, key)), records.Stringify(orNil(after, key))) {
			fields = append(fields, key)
		}
	}
	return fields
}

// SettingsAuditDetail is the CONFIG_UPDATE detail: the phase when it changed, then the fields.
func SettingsAuditDetail(after *records.Object, fields []string) string {
	detail := "Campos: " + strings.Join(fields, ", ")
	if !slices.Contains(fields, "phase") {
		return detail
	}
	if id, ok := orNil(after, "phase").(string); ok {
		return "Fase " + PhaseLabels[id] + "; " + detail
	}
	return "Fase sin definir; " + detail
}

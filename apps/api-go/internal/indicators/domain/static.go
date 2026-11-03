package domain

import (
	"encoding/json"
	"errors"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

// ModelStatus is JSON.stringify(MODEL_STATUS) of domain/defaults.ts (data/model_status.json): a
// constant the engine does not export.
//
//nolint:misspell // Spanish text, verbatim from the TypeScript API.
const ModelStatus = `{"version":"SIPGES · Prototipo final de tesis | Motor V0.5.1",` +
	`"content_validation":"Pendiente de juicio de expertos","aiken_status":"Sin resultados todavía",` +
	`"indicator_count":32,"dimensions":["G","A","D","N","E","I"],` +
	`"canonical_entity":"Comunidad Campesina San Martín de Sechura (CCSMS)",` +
	`"release_rule":"La interfaz está finalizada para la tesis. La condición de “modelo validado” solo se ` +
	`asignará después del juicio de expertos y la evaluación funcional contra Gold Standard.",` +
	`"classifier":"Reglas ponderadas y contextuales",` +
	`"functional_validation":"Protocolo preparado; Gold Standard pendiente","ui_release":"Web Final RC 1.0"}`

type templateRow struct {
	Dimension  string  `json:"dimension"`
	Code       string  `json:"code"`
	Name       string  `json:"name"`
	Definition string  `json:"definition"`
	Expert1    *string `json:"expert_1"`
	Expert2    *string `json:"expert_2"`
	Expert3    *string `json:"expert_3"`
	Expert4    *string `json:"expert_4"`
	Expert5    *string `json:"expert_5"`
	AikenV     *string `json:"aiken_v"`
	Decision   string  `json:"decision"`
}

// ValidationTemplate is validationTemplate of indicators-service.ts: one pending row per
// indicator of indicatorConfig (INDICATOR_CONFIG, `{dimension: [{code, name, definition}]}`), in
// its order.
func ValidationTemplate(indicatorConfig json.RawMessage) (json.RawMessage, error) {
	dims, err := members(indicatorConfig)
	if err != nil {
		return nil, err
	}
	rows := []templateRow{}
	for _, d := range dims {
		var items []struct {
			Code       string `json:"code"`
			Name       string `json:"name"`
			Definition string `json:"definition"`
		}
		if err := json.Unmarshal(d.value, &items); err != nil {
			return nil, err
		}
		for _, it := range items {
			rows = append(rows, templateRow{
				Dimension: d.key, Code: it.Code, Name: it.Name, Definition: it.Definition, Decision: "Pendiente",
			})
		}
	}
	return Encode(struct {
		Status string        `json:"status"`
		Rows   []templateRow `json:"rows"`
	}{"PENDIENTE", rows})
}

// HistoryLimitError is the 422 body of GET /system/irsa/history for a `limit` that is not an
// integer, as indicators-routes.ts writes it.
var HistoryLimitError = map[string]any{"detail": []struct {
	Type string   `json:"type"`
	Loc  []string `json:"loc"`
	Msg  string   `json:"msg"`
}{{"int_parsing", []string{"query", "limit"}, "Input should be a valid integer, unable to parse string as an integer"}}}

// defaultHistoryLimit is the IrsaHistoryQuery default.
const defaultHistoryLimit = 50

// HistoryLimit is IrsaHistoryQuery (`z.coerce.number().int().default(50)`) plus the route's
// rule: a negative limit means every snapshot (nil). present is whether the query names `limit`
// at all; ok is false when the value is not a safe integer once coerced with Number().
func HistoryLimit(raw string, present bool) (limit *int64, ok bool) {
	if !present {
		n := int64(defaultHistoryLimit)
		return &n, true
	}
	f, ok := jsNumber(raw)
	if !ok || math.IsInf(f, 0) || math.IsNaN(f) || f != math.Trunc(f) || math.Abs(f) > maxSafeInteger {
		return nil, false
	}
	if f < 0 {
		return nil, true
	}
	n := int64(f)
	return &n, true
}

const maxSafeInteger = 1<<53 - 1

// jsWhitespace is ECMAScript WhiteSpace and LineTerminator, which Number() trims.
const jsWhitespace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009" +
	"\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

var (
	decimalLiteral = regexp.MustCompile(`^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)
	infinity       = regexp.MustCompile(`^[+-]?Infinity$`)
	radixLiteral   = regexp.MustCompile(`^0(?:[xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)$`)
)

// jsNumber is JavaScript's Number(string); ok is false where it gives NaN.
func jsNumber(raw string) (float64, bool) {
	s := strings.Trim(raw, jsWhitespace)
	switch {
	case s == "":
		return 0, true
	case infinity.MatchString(s):
		return math.Inf(1), true
	case radixLiteral.MatchString(s):
		n, ok := new(big.Int).SetString(s[2:], radixOf(s[1]))
		if !ok {
			return 0, false
		}
		f, _ := new(big.Float).SetInt(n).Float64()
		return f, true
	case decimalLiteral.MatchString(s):
		f, err := strconv.ParseFloat(s, 64)
		// Out of range is ±Inf (overflow) or ±0 (underflow), as in JavaScript.
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return 0, false
		}
		return f, true
	}
	return 0, false
}

func radixOf(c byte) int {
	switch c {
	case 'x', 'X':
		return 16
	case 'o', 'O':
		return 8
	}
	return 2
}

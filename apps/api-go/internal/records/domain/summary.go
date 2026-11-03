//nolint:misspell // Spanish module slugs and record fields, verbatim from the TypeScript API.
package domain

import "strings"

// columns says where each column of Registros «Todos» lives in a type's payload: the canonical
// key first, then the imported aliases (summary.ts).
type columns struct {
	title, territory, date, verification, validation []string
}

// SummaryType is one hub record type of SUMMARY_TYPES.
type SummaryType struct {
	Slug   string
	Module string
	cols   columns
}

var (
	territory    = []string{"Territorio"}
	verification = []string{"Nivel_Verificacion"}
)

// SummaryTypes is SUMMARY_TYPES: the hub record types in the order of the Registros chips.
var SummaryTypes = []SummaryType{
	{"eventos", "Eventos", columns{[]string{"Descripcion_Hecho"}, territory, []string{"Fecha"}, verification, []string{"Estado_Validacion"}}},
	{"actores", "Actores", columns{[]string{"Nombre_Actor/Organizacion"}, territory, nil, nil, nil}},
	{"directorio", "Directorio_Territorial", columns{
		[]string{"Nombre", "Nombre actualizado 2026"},
		[]string{"Territorio", "Lugar / ámbito", "Ciudad", "Distrito", "Localidad"}, nil, nil, nil,
	}},
	{"demandas", "Demandas", columns{[]string{"Descripcion"}, territory, []string{"Fecha_Registro"}, nil, nil}},
	{"narrativas", "Narrativas", columns{[]string{"Descripcion"}, nil, []string{"Fecha_Inicio"}, verification, nil}},
	{"fuentes", "Fuentes", columns{[]string{"Archivo_Fuente"}, nil, []string{"Fecha_Documento"}, []string{"Nivel_Base_Verificacion"}, nil}},
	{"buzon", "Buzon", columns{[]string{"Asunto"}, territory, []string{"Fecha"}, nil, nil}},
}

// SummaryModules is the stored module names of SummaryTypes, in order.
func SummaryModules() []string {
	out := make([]string, len(SummaryTypes))
	for i, t := range SummaryTypes {
		out[i] = t.Module
	}
	return out
}

// RecordSummary is RecordSummary of summary.ts; Verification is nil without an A–E grade.
type RecordSummary struct {
	Slug         string
	ID           string
	Title        string
	Territory    string
	Date         string
	Verification *string
	Validation   string
}

// display is `value == null ? ” : typeof value === 'object' ? JSON.stringify(value) : String(value)`.
func display(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return NumberString(x)
	default:
		return string(Stringify(x))
	}
}

// read is read of summary.ts: the canonical key wins when present (even cleared), otherwise the
// first filled alias.
func read(payload *Object, keys []string) string {
	if len(keys) == 0 {
		return ""
	}
	if v, ok := payload.Get(keys[0]); ok {
		return trimJS(display(v))
	}
	for _, alias := range keys[1:] {
		v, ok := payload.Get(alias)
		if ok && v != nil && v != "" {
			return trimJS(display(v))
		}
	}
	return ""
}

var letters = []string{"A", "B", "C", "D", "E"}

// letterOf is letterOf: «B - Corroborada» → B; other wordings have no grade.
func letterOf(label string) *string {
	for _, l := range letters {
		if strings.HasPrefix(label, l+" -") {
			return &l
		}
	}
	return nil
}

// Summarize is summarizeRecord: the columns of Registros «Todos» for one stored record.
func Summarize(t SummaryType, id string, payload *Object) RecordSummary {
	title := read(payload, t.cols.title)
	if title == "" {
		title = id
	}
	return RecordSummary{
		Slug:         t.Slug,
		ID:           id,
		Title:        title,
		Territory:    read(payload, t.cols.territory),
		Date:         read(payload, t.cols.date),
		Verification: letterOf(read(payload, t.cols.verification)),
		Validation:   read(payload, t.cols.validation),
	}
}

//nolint:misspell // Spanish record fields, modules and messages, verbatim from the TypeScript API.
package domain

import (
	"encoding/json"
	"slices"
)

// The ontology catalog of apps/api/src/contexts/ontology/domain/catalog.ts, read-only: what the
// analyst needs to name records and follow their links. It moves to the ontology context when
// that context is ported.

// ObjectType is a territorial record type.
type ObjectType struct {
	Slug          string
	Module        string
	Label         string
	TitleField    string
	SummaryFields []string
	DateField     string // "" when the type has no date
}

// ObjectTypes is OBJECT_TYPES, in catalog order.
var ObjectTypes = []ObjectType{
	{"actores", "Actores", "Actor", "Nombre_Actor/Organizacion", []string{"Tipo_Actor", "Posicion_Proyecto", "Influencia", "Territorio"}, ""},
	{"eventos", "Eventos", "Evento", "Descripcion_Hecho", []string{"Tipo_Evento", "Territorio", "Relevancia_Preliminar", "Estado_Validacion"}, "Fecha"},
	{"demandas", "Demandas", "Demanda", "Descripcion", []string{"Actor/Grupo", "Tema", "Prioridad", "Estado"}, "Fecha_Registro"},
	{"compromisos", "Compromisos", "Compromiso", "Descripcion", []string{"Actor/Entidad", "Responsable", "Plazo", "Avance_%", "Estado"}, "Fecha"},
	{"narrativas", "Narrativas", "Narrativa", "Descripcion", []string{"Plataforma/Fuente", "Tema", "Tono", "Estado"}, "Fecha_Observacion"},
	{"fuentes", "Fuentes", "Fuente", "Archivo_Fuente", []string{"Tipo_Fuente", "Institucion/Autor", "Nivel_Base_Verificacion"}, "Fecha_Documento"},
	{"alertas", "Alertas", "Alerta", "Causa", []string{"Dimension", "Nivel_Preliminar", "Estado"}, "Fecha"},
	{"acciones", "Acciones", "Acción", "Accion", []string{"Responsable", "Plazo", "Estado"}, ""},
	{"directorio", "Directorio_Territorial", "Contacto", "Nombre", []string{"Cargo", "Institucion", "Prioridad"}, ""},
	{"intereses", "Intereses", "Interés", "Actor", []string{"Posicion", "Interes", "Estado"}, ""},
	{"dialogos", "Dialogos", "Diálogo", "Proceso", []string{"Tema", "Acuerdo", "Proximo_Paso", "Estado"}, ""},
	{"oportunidades", "Oportunidades", "Oportunidad", "Oportunidad", []string{"Tipo", "Beneficiarios", "Viabilidad", "Estado"}, ""},
	{"hechos", "Hechos_Compartidos", "Hecho compartido", "Asunto", []string{"Metodo", "Accion_Verificacion", "Estado"}, ""},
	{"aarc", "Evaluaciones_AARC", "Evaluación AARC", "Actor_Proceso", []string{"Accion_Mejora", "Estado"}, "Fecha"},
	{"buzon", "Buzon", "Caso del buzón", "Asunto", []string{"Tipo", "Territorio", "Estado"}, "Fecha"},
	{"lecciones", "Lecciones_Territoriales", "Lección territorial", "Aprendido", []string{"Territorio", "Tema", "Actor"}, "Fecha"},
}

// ObjectTypeForSlug is objectTypeForSlug.
func ObjectTypeForSlug(slug string) (ObjectType, bool) {
	for _, t := range ObjectTypes {
		if t.Slug == slug {
			return t, true
		}
	}
	return ObjectType{}, false
}

// ObjectTypeForModule is objectTypeForModule.
func ObjectTypeForModule(module string) (ObjectType, bool) {
	for _, t := range ObjectTypes {
		if t.Module == module {
			return t, true
		}
	}
	return ObjectType{}, false
}

// LinkType is a typed link between records.
type LinkType struct {
	ID           string
	Label        string
	InverseLabel string
	Sources      []string // nil accepts every object type
	Targets      []string
	Symmetric    bool
}

// LinkTypes is LINK_TYPES, in catalog order.
var LinkTypes = []LinkType{
	{"participa_en", "participa en", "tiene como participante a", []string{"actores"}, []string{"eventos", "dialogos"}, false},
	{"plantea", "plantea", "es planteada por", []string{"actores"}, []string{"demandas"}, false},
	{"asume", "asume", "es asumido por", []string{"actores"}, []string{"compromisos"}, false},
	{"responde_a", "responde a", "es atendida por", []string{"compromisos", "acciones", "oportunidades"}, []string{"demandas"}, false},
	{"difunde", "difunde", "es difundida por", []string{"actores"}, []string{"narrativas"}, false},
	{"sustenta", "sustenta", "se sustenta en", []string{"fuentes"}, nil, false},
	{"origina", "origina", "se origina en", []string{"eventos", "narrativas", "demandas"}, []string{"alertas"}, false},
	{"atiende", "atiende", "es atendida por", []string{"acciones"}, []string{"alertas"}, false},
	{"representa_a", "representa a", "es representado por", []string{"directorio"}, []string{"actores"}, false},
	{"aliado_de", "es aliado de", "es aliado de", []string{"actores"}, []string{"actores"}, true},
	{"en_conflicto_con", "está en conflicto con", "está en conflicto con", []string{"actores"}, []string{"actores"}, true},
	{"relacionado_con", "está relacionado con", "está relacionado con", nil, nil, true},
}

// LinkTypeByID is linkTypeById.
func LinkTypeByID(id string) (LinkType, bool) {
	for _, t := range LinkTypes {
		if t.ID == id {
			return t, true
		}
	}
	return LinkType{}, false
}

func accepts(allowed []string, slug string) bool {
	return allowed == nil || slices.Contains(allowed, slug)
}

// Ref is a record by slug and id.
type Ref struct {
	Slug string
	ID   string
}

// linkAllowed is checkLink(...) === null.
func linkAllowed(linkTypeID string, source, target Ref) bool {
	t, ok := LinkTypeByID(linkTypeID)
	if !ok {
		return false
	}
	if _, ok := ObjectTypeForSlug(source.Slug); !ok {
		return false
	}
	if _, ok := ObjectTypeForSlug(target.Slug); !ok {
		return false
	}
	if source == target {
		return false
	}
	forward := accepts(t.Sources, source.Slug) && accepts(t.Targets, target.Slug)
	backward := t.Symmetric && accepts(t.Sources, target.Slug) && accepts(t.Targets, source.Slug)
	return forward || backward
}

// SuggestedLink is suggestedLink of mentions.ts: the most specific non-symmetric link type the
// catalog allows between a and b, oriented as it reads, else "relacionado_con" from a to b.
func SuggestedLink(a, b Ref) (linkType string, source, target Ref) {
	for _, t := range LinkTypes {
		if t.Symmetric {
			continue
		}
		if linkAllowed(t.ID, a, b) {
			return t.ID, a, b
		}
		if linkAllowed(t.ID, b, a) {
			return t.ID, b, a
		}
	}
	return "relacionado_con", a, b
}

// InferenceRule is a link read from a reference field already present in payloads.
type InferenceRule struct {
	LinkType       string
	Holder         string
	Field          string
	Target         string
	MatchTitle     bool // false: by id
	HolderIsSource bool
}

// InferenceRules is INFERENCE_RULES; a rule's index is its position.
var InferenceRules = func() []InferenceRule {
	rules := make([]InferenceRule, 0, 19)
	for _, holder := range []string{"eventos", "actores", "directorio", "demandas", "compromisos", "narrativas",
		"alertas", "acciones", "intereses", "dialogos", "oportunidades", "hechos"} {
		rules = append(rules, InferenceRule{"sustenta", holder, "Fuente_ID", "fuentes", false, false})
	}
	return append(rules,
		InferenceRule{"atiende", "acciones", "Alerta_Asociada", "alertas", false, true},
		InferenceRule{"responde_a", "compromisos", "Demanda_Asociada", "demandas", false, true},
		InferenceRule{"participa_en", "eventos", "Actor_Principal", "actores", true, false},
		InferenceRule{"plantea", "demandas", "Actor/Grupo", "actores", true, false},
		InferenceRule{"asume", "compromisos", "Actor/Entidad", "actores", true, false},
		InferenceRule{"difunde", "narrativas", "Actor_Relacionado", "actores", true, false},
		InferenceRule{"relacionado_con", "intereses", "Actor", "actores", true, true},
	)
}()

// maxTitle bounds a record title (titleOf).
const maxTitle = 140

// TitleOf is titleOf: the title field of a string or number, trimmed and cut to 140 UTF-16
// units, else the id.
func TitleOf(t ObjectType, id string, payload Payload) string {
	value, _ := payload.Get(t.TitleField)
	var text string
	switch v := value.(type) {
	case string:
		text = trimJS(v)
	case json.Number:
		text = jsNumber(numberOf(v))
	}
	if text == "" {
		return id
	}
	if len16(text) > maxTitle {
		return slice16(text, 0, maxTitle-1) + "…"
	}
	return text
}

// Summary is ObjectSummary (briefing.ts calls it Subject).
type Summary struct {
	Slug      string
	ID        string
	TypeLabel string
	Title     string
	Date      *string
	Marking   string
	// Fields are the type's summary fields with a value, in catalog order.
	Fields []Field
}

// Field reads a summary field ("" when absent).
func (s Summary) Field(name string) string {
	for _, f := range s.Fields {
		if f.Key == name {
			v, _ := f.Value.(string)
			return v
		}
	}
	return ""
}

// Ref is the summary's record.
func (s Summary) Ref() Ref { return Ref{s.Slug, s.ID} }

// Summarize is summarize of ontology-service.ts without extra fields.
func Summarize(t ObjectType, id, marking string, payload Payload) Summary {
	s := Summary{Slug: t.Slug, ID: id, TypeLabel: t.Label, Title: TitleOf(t, id, payload), Marking: marking, Fields: []Field{}}
	if t.DateField != "" {
		value, _ := payload.Get(t.DateField)
		if date := textOf(value); date != "" {
			s.Date = &date
		}
	}
	for _, field := range t.SummaryFields {
		value, _ := payload.Get(field)
		if text := textOf(value); text != "" {
			s.Fields = append(s.Fields, Field{Key: field, Value: text})
		}
	}
	return s
}

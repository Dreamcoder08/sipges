// Package domain is the Go port of apps/api/src/contexts/ontology/domain: the catalog of object
// and link types (docs/adr/0011), record titles and summaries, and the lexical search rules,
// with the JavaScript string semantics the TypeScript API answers with.
//
//nolint:misspell // Spanish modules, fields and labels, verbatim from the TypeScript catalog.
package domain

// ObjectType is ObjectType of catalog.ts.
type ObjectType struct {
	// Slug is the URL slug used by /api/{module}.
	Slug string
	// Module is the stored module name in module_records.
	Module        string
	Label         string
	TitleField    string
	SummaryFields []string
	// DateField holds the record's own date (ISO yyyy-mm-dd); empty when it has none.
	DateField string
}

func objectType(slug, module, label, titleField string, summaryFields []string, dateField string) ObjectType {
	return ObjectType{Slug: slug, Module: module, Label: label, TitleField: titleField, SummaryFields: summaryFields, DateField: dateField}
}

// ObjectTypes is OBJECT_TYPES, in its order.
var ObjectTypes = []ObjectType{
	objectType("actores", "Actores", "Actor", "Nombre_Actor/Organizacion",
		[]string{"Tipo_Actor", "Posicion_Proyecto", "Influencia", "Territorio"}, ""),
	objectType("eventos", "Eventos", "Evento", "Descripcion_Hecho",
		[]string{"Tipo_Evento", "Territorio", "Relevancia_Preliminar", "Estado_Validacion"}, "Fecha"),
	objectType("demandas", "Demandas", "Demanda", "Descripcion",
		[]string{"Actor/Grupo", "Tema", "Prioridad", "Estado"}, "Fecha_Registro"),
	objectType("compromisos", "Compromisos", "Compromiso", "Descripcion",
		[]string{"Actor/Entidad", "Responsable", "Plazo", "Avance_%", "Estado"}, "Fecha"),
	objectType("narrativas", "Narrativas", "Narrativa", "Descripcion",
		[]string{"Plataforma/Fuente", "Tema", "Tono", "Estado"}, "Fecha_Observacion"),
	objectType("fuentes", "Fuentes", "Fuente", "Archivo_Fuente",
		[]string{"Tipo_Fuente", "Institucion/Autor", "Nivel_Base_Verificacion"}, "Fecha_Documento"),
	objectType("alertas", "Alertas", "Alerta", "Causa",
		[]string{"Dimension", "Nivel_Preliminar", "Estado"}, "Fecha"),
	objectType("acciones", "Acciones", "Acción", "Accion", []string{"Responsable", "Plazo", "Estado"}, ""),
	objectType("directorio", "Directorio_Territorial", "Contacto", "Nombre",
		[]string{"Cargo", "Institucion", "Prioridad"}, ""),
	objectType("intereses", "Intereses", "Interés", "Actor", []string{"Posicion", "Interes", "Estado"}, ""),
	objectType("dialogos", "Dialogos", "Diálogo", "Proceso", []string{"Tema", "Acuerdo", "Proximo_Paso", "Estado"}, ""),
	objectType("oportunidades", "Oportunidades", "Oportunidad", "Oportunidad",
		[]string{"Tipo", "Beneficiarios", "Viabilidad", "Estado"}, ""),
	objectType("hechos", "Hechos_Compartidos", "Hecho compartido", "Asunto",
		[]string{"Metodo", "Accion_Verificacion", "Estado"}, ""),
	objectType("aarc", "Evaluaciones_AARC", "Evaluación AARC", "Actor_Proceso",
		[]string{"Accion_Mejora", "Estado"}, "Fecha"),
	objectType("buzon", "Buzon", "Caso del buzón", "Asunto", []string{"Tipo", "Territorio", "Estado"}, "Fecha"),
	objectType("lecciones", "Lecciones_Territoriales", "Lección territorial", "Aprendido",
		[]string{"Territorio", "Tema", "Actor"}, "Fecha"),
}

var (
	bySlug   = map[string]ObjectType{}
	byModule = map[string]ObjectType{}
	byLink   = map[string]LinkType{}
)

func init() {
	for _, t := range ObjectTypes {
		bySlug[t.Slug] = t
		byModule[t.Module] = t
	}
	for _, l := range LinkTypes {
		byLink[l.ID] = l
	}
}

// ObjectTypeForSlug is objectTypeForSlug.
func ObjectTypeForSlug(slug string) (ObjectType, bool) {
	t, ok := bySlug[slug]
	return t, ok
}

// ObjectTypeForModule is objectTypeForModule.
func ObjectTypeForModule(module string) (ObjectType, bool) {
	t, ok := byModule[module]
	return t, ok
}

// LinkType is LinkType of catalog.ts. Nil Sources or Targets accept every object type.
type LinkType struct {
	ID           string
	Label        string
	InverseLabel string
	Sources      []string
	Targets      []string
	Symmetric    bool
}

// LinkTypes is LINK_TYPES, in its order.
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
	l, ok := byLink[id]
	return l, ok
}

// InferenceRule is InferenceRule of catalog.ts: Field lives on the Holder record and points at
// a Target record by id or by its title; HolderIsSource says which end the link starts from.
type InferenceRule struct {
	LinkType       string
	Holder         string
	Field          string
	Target         string
	Match          string // "id" or "title"
	HolderIsSource bool
}

// InferenceRules is INFERENCE_RULES, in its order (the index is the rule's id in SQL).
var InferenceRules = func() []InferenceRule {
	holders := []string{"eventos", "actores", "directorio", "demandas", "compromisos", "narrativas",
		"alertas", "acciones", "intereses", "dialogos", "oportunidades", "hechos"}
	rules := make([]InferenceRule, 0, len(holders)+7)
	for _, holder := range holders {
		rules = append(rules, InferenceRule{"sustenta", holder, "Fuente_ID", "fuentes", "id", false})
	}
	return append(rules,
		InferenceRule{"atiende", "acciones", "Alerta_Asociada", "alertas", "id", true},
		InferenceRule{"responde_a", "compromisos", "Demanda_Asociada", "demandas", "id", true},
		InferenceRule{"participa_en", "eventos", "Actor_Principal", "actores", "title", false},
		InferenceRule{"plantea", "demandas", "Actor/Grupo", "actores", "title", false},
		InferenceRule{"asume", "compromisos", "Actor/Entidad", "actores", "title", false},
		InferenceRule{"difunde", "narrativas", "Actor_Relacionado", "actores", "title", false},
		InferenceRule{"relacionado_con", "intereses", "Actor", "actores", "title", true},
	)
}()

// CatalogJSON is the body of GET /system/ontology (OntologyCatalog of @sipges/contracts).
type CatalogJSON struct {
	ObjectTypes []objectTypeJSON `json:"object_types"`
	LinkTypes   []linkTypeJSON   `json:"link_types"`
}

type objectTypeJSON struct {
	Module        string   `json:"module"`
	Label         string   `json:"label"`
	TitleField    string   `json:"title_field"`
	SummaryFields []string `json:"summary_fields"`
	DateField     *string  `json:"date_field"`
}

type linkTypeJSON struct {
	ID           string   `json:"id"`
	Label        string   `json:"label"`
	InverseLabel string   `json:"inverse_label"`
	Sources      []string `json:"sources"`
	Targets      []string `json:"targets"`
	Symmetric    bool     `json:"symmetric"`
}

// Catalog is the catalog route's body.
func Catalog() CatalogJSON {
	out := CatalogJSON{
		ObjectTypes: make([]objectTypeJSON, 0, len(ObjectTypes)),
		LinkTypes:   make([]linkTypeJSON, 0, len(LinkTypes)),
	}
	for _, t := range ObjectTypes {
		o := objectTypeJSON{Module: t.Slug, Label: t.Label, TitleField: t.TitleField, SummaryFields: t.SummaryFields}
		if t.DateField != "" {
			o.DateField = &t.DateField
		}
		out.ObjectTypes = append(out.ObjectTypes, o)
	}
	for _, l := range LinkTypes {
		out.LinkTypes = append(out.LinkTypes, linkTypeJSON(l))
	}
	return out
}

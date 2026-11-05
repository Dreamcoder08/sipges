// Package domain holds the pure rules of the privacy context: what may leave SIPGES for an external
// model or client, and how names and contact data are replaced on the way out.
package domain

import "regexp"

// Field allowlists per record module (docs/adr/0030, Ley 29733 art. 13.5 and 13.6). This is the
// only place that decides which fields may leave SIPGES for an external model or client: anything
// not listed is dropped, so a new or imported field is private until someone reads it here and
// says why it is not sensitive. Port of allowlist.ts; the fixture test compares both tables whole.
//
// Each field has one treatment:
//   - PolicyClear: a code, a date, a number or a value from a closed list; no person can be read in it.
//   - PolicyText: free text, sent after known names and contact data are replaced.
//   - PolicyName: one person or organisation, always replaced by its pseudonym, known or not.
//   - PolicyNames: a list of them; every item is replaced.
//
// Never allowed, whatever the module: political opinion or stance, ethnic origin, health, religion,
// union membership, income, biometrics, contact data and identity numbers (NeverAllowed, enforced
// by a test over this file). Contact fields are dropped, not pseudonymised: an agent has no need
// to reach anyone.

// PolicyKind is the treatment of a field.
type PolicyKind string

// The treatments.
const (
	PolicyClear PolicyKind = "clear"
	PolicyText  PolicyKind = "text"
	PolicyName  PolicyKind = "name"
	PolicyNames PolicyKind = "names"
)

// FieldPolicy is how one field may leave.
type FieldPolicy struct {
	Kind PolicyKind
	// Entity is, for PolicyName and PolicyNames, the kind of pseudonym when the project does not
	// know the name.
	Entity PseudonymKind
	// Why says why sending this field, treated this way, does not expose sensitive data.
	Why string
}

// NamedPolicy is one allowed field.
type NamedPolicy struct {
	Field  string
	Policy FieldPolicy
}

// ModulePolicy is the allowed fields of a module, keyed by its slug (/api/{slug}) like the ontology
// catalogue, in the order of allowlist.ts.
type ModulePolicy struct {
	Slug   string
	Fields []NamedPolicy
}

func clear(why string) FieldPolicy { return FieldPolicy{Kind: PolicyClear, Why: why} }
func text(why string) FieldPolicy  { return FieldPolicy{Kind: PolicyText, Why: why} }
func name(entity PseudonymKind, why string) FieldPolicy {
	return FieldPolicy{Kind: PolicyName, Entity: entity, Why: why}
}
func names(entity PseudonymKind, why string) FieldPolicy {
	return FieldPolicy{Kind: PolicyNames, Entity: entity, Why: why}
}
func recordID(why string) FieldPolicy {
	return clear(why + " Record codes are already sent as ids.")
}

var (
	source        = clear("Reference to a source record (an id such as F-12), not a person.")
	date          = clear("A calendar date of the record; no person is identified by it.")
	territory     = clear("Community or district named for the territorial analysis, not a person.")
	status        = clear("Workflow state from a closed list (Pendiente, Cerrada...).")
	priorityLevel = clear("Priority or level from a closed list.")
	deadline      = clear("A due date or term, as written; no person is identified by it.")
	responsible   = name(Persona, "The responsible person becomes a pseudonym; the name never leaves.")
	actor         = name(Actor, "The actor or organisation becomes a pseudonym; the name never leaves.")
)

// FieldPolicies is the allowlist.
var FieldPolicies = []ModulePolicy{
	{Slug: "actores", Fields: []NamedPolicy{
		{"ID_Actor", recordID("Id of the actor.")},
		{"Nombre_Actor/Organizacion", actor}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"Tipo_Actor", clear("Category from a closed list (comunidad, empresa, institución pública...).")},
		{"Territorio", territory},
		{"Sector", clear("Sector of the actor map from a closed list.")},
		{"Influencia", clear("Assessed level of influence of the actor or organisation, from a closed list.")},
		{"Tipo_Relacion", clear("Strength of the relationship (Fuerte/Débil), from a closed list.")},
		{"Sentido_Relacion", clear("Direction of the relationship, from a closed list.")},
		{"Fuente_ID", source},
		// Dropped: Posicion_Proyecto (political stance), Interes and Rol/Relacion (what an actor
		// wants or does, free text that may reveal opinion or union role), Observaciones (notes).
	}},
	{Slug: "eventos", Fields: []NamedPolicy{
		{"ID_Evento", recordID("Id of the event.")},
		{"Fecha", date},
		{"Territorio", territory},
		{"Actor_Principal", actor},
		{"Tipo_Evento", clear("Kind of event, a short label.")},
		{"Descripcion_Hecho", text("The documented fact; named people and contact data are replaced.")},
		{"Dimension_Principal", clear("IRSA dimension from a closed list.")},
		{"Relevancia_Preliminar", priorityLevel},
		{"Nivel_Verificacion", clear("Verification level of the information, from a closed list.")}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"Estado_Validacion", status},
		{"Estado_Informacion", clear("Observed, estimated or hypothetical, from a closed list.")}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"Fuente_ID", source},
	}},
	{Slug: "demandas", Fields: []NamedPolicy{ //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"ID_Demanda", recordID("Id of the demand.")},
		{"Fecha_Registro", date},
		{"Actor/Grupo", actor},
		{"Territorio", territory},
		{"Tema", text("Subject of the demand, a short phrase.")},
		{"Descripcion", text("The demand as documented; named people and contact data are replaced.")},
		{"Prioridad", priorityLevel},
		{"Estado", status},
		{"Fuente_ID", source},
	}},
	{Slug: "compromisos", Fields: []NamedPolicy{
		{"ID_Compromiso", recordID("Id of the commitment.")},
		{"Fecha", date},
		{"Descripcion", text("The commitment as documented; named people and contact data are replaced.")},
		{"Actor/Entidad", actor},
		{"Demanda_Asociada", clear("Reference to a demand record, not a person.")},
		{"Responsable", responsible}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"Plazo", deadline},
		{"Fecha_Vencimiento", date},
		{"Avance_%", clear("Progress percentage; a number.")},
		{"Estado", status},
		{"Evidencia_Cierre", text("Description of the closing evidence; names and contact data are replaced.")},
		{"Fuente_ID", source},
	}},
	{Slug: "narrativas", Fields: []NamedPolicy{ //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"ID_Narrativa", recordID("Id of the narrative.")},
		{"Fecha_Inicio", date},
		{"Fecha_Observacion", date}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"Plataforma/Fuente", text("Medium or platform where it was seen; scrubbed in case it names a page.")},
		{"Tema", text("Subject of the narrative, a short phrase.")},
		{"Categoria", clear("IRSA dimension from a closed list.")},
		{"Actor_Relacionado", actor},
		{"Interacciones_Observadas", clear("Number of interactions; a count.")},
		{"Descripcion", text("The narrative as documented; named people and contact data are replaced.")},
		{"Intensidad", priorityLevel},
		{"Nivel_Verificacion", clear("Verification level of the information, from a closed list.")}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"Estado", status},
		{"Fuente_ID", source},
		// Dropped: URL_Publicacion (can identify an author), Tono (stance towards the project).
	}},
	{Slug: "fuentes", Fields: []NamedPolicy{
		{"ID_Fuente", recordID("Id of the source.")},
		{"Fecha_Documento", date},
		{"Archivo_Fuente", text("Name of the document; names and contact data are replaced.")},
		{"Tipo_Fuente", clear("Kind of source from a closed list.")},
		{"Institucion/Autor", name(Org, "Institution or author becomes a pseudonym.")}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"Periodo_Cubierto", clear("Period the source covers, a date range.")},
		{"Nivel_Base_Verificacion", clear("Verification level of the source, from a closed list.")}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
	}},
	{Slug: "alertas", Fields: []NamedPolicy{
		{"ID_Alerta", recordID("Id of the alert.")},
		{"Fecha", date},
		{"Causa", text("Documented cause of the alert; named people and contact data are replaced.")},
		{"Territorio", territory},
		{"Dimension", clear("IRSA dimension letter (G, A, D, N, E, I).")},
		{"Nivel_Preliminar", clear("Colour level (Verde, Amarillo, Naranja, Rojo).")},
		{"Estado", status},
		{"Accion_Sugerida", text("Suggested action; named people and contact data are replaced.")},
		{"Fuente_ID", source},
	}},
	{Slug: "acciones", Fields: []NamedPolicy{
		{"ID_Accion", recordID("Id of the action.")},
		{"Accion", text("The action as documented; named people and contact data are replaced.")},
		{"Alerta_Asociada", clear("Reference to an alert record, not a person.")},
		{"Responsable", responsible}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"Plazo", deadline},
		{"Fecha_Vencimiento", date},
		{"Estado", status},
		{"Resultado", text("Result obtained; named people and contact data are replaced.")},
		{"Fuente_ID", source},
	}},
	{Slug: "directorio", Fields: []NamedPolicy{
		{"Nombre", name(Persona, "The contact becomes a pseudonym; the name never leaves.")},
		{"Institucion", name(Org, "The institution becomes a pseudonym.")}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"Territorio", territory},
		{"Tipo_Actor", clear("Category from a closed list.")},
		{"Prioridad", priorityLevel},
		{"Estado_Verificacion", clear("Verification state of the entry, from a closed list.")}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"Fuente_ID", source},
		// Dropped: Cargo (a unique job title identifies its holder), Telefono and any other contact.
	}},
	{Slug: "intereses", Fields: []NamedPolicy{
		{"Actor", actor},
		{"Estado", clear("Verification state of the record, from a closed list.")},
		{"Fuente_ID", source},
		// Dropped: Posicion, Interes, Preocupacion, Mandato, Alternativa: the stance of actors.
	}},
	{Slug: "dialogos", Fields: []NamedPolicy{
		{"Proceso", text("Name of the dialogue process; scrubbed.")},
		{"Participantes", names(Actor, "Every participant becomes a pseudonym.")}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"Tema", text("Subject of the dialogue, a short phrase.")},
		{"Opciones", text("Options considered in the process; names and contact data are replaced.")},
		{"Acuerdo", text("Agreement reached or not; names and contact data are replaced.")},
		{"Responsable", responsible}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"Proximo_Paso", text("Next step and term; names and contact data are replaced.")},
		{"Fuente_ID", source},
		{"Estado", status},
	}},
	{Slug: "oportunidades", Fields: []NamedPolicy{
		{"Oportunidad", text("The opportunity as documented; names and contact data are replaced.")},
		{"Tipo", clear("Kind of opportunity, a short label.")},
		{"Beneficiarios", text("Groups expected to benefit; names and contact data are replaced.")},
		{"Viabilidad", text("Conditions of viability; names and contact data are replaced.")},
		{"Restricciones", text("Technical or legal restrictions; names and contact data are replaced.")},
		{"Responsable", responsible}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"Plazo", deadline},
		{"Fuente_ID", source},
		{"Estado", status},
	}},
	{Slug: "hechos", Fields: []NamedPolicy{
		{"Asunto", text("Question to verify; names and contact data are replaced.")},
		{"Versiones", text("Discrepant versions of the information; names and contact data are replaced.")}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"Preguntas", text("Questions agreed; names and contact data are replaced.")},
		{"Metodo", text("Method of verification; names and contact data are replaced.")},
		{"Participantes", names(Actor, "Every participant becomes a pseudonym.")}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"Fuente_ID", source},
		{"Accion_Verificacion", text("Next verification step; names and contact data are replaced.")}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"Estado", status},
	}},
	{Slug: "aarc", Fields: []NamedPolicy{
		{"Actor_Proceso", actor},
		{"Accion_Mejora", text("Improvement action; names and contact data are replaced.")},
		{"Fecha", date},
		{"Estado", status},
		// Dropped: Reconocimiento, Agencia, Reciprocidad, Claridad, Evidencia: assessments of how
		// an actor perceives the relationship.
	}},
	{Slug: "buzon", Fields: []NamedPolicy{
		{"ID_Caso", recordID("Id of the case.")},
		{"Fecha", date},
		{"Tipo", clear("Queja, Denuncia, Consulta or Sugerencia.")},
		{"Canal", clear("Channel the case came through, from a closed list.")},
		{"Territorio", territory},
		{"Actor_Relacionado", actor},
		{"Tema", text("Subject of the case, a short phrase.")},
		{"Asunto", text("Subject line of the case; names and contact data are replaced.")},
		{"Prioridad", priorityLevel},
		{"Responsable", responsible}, //nolint:misspell // Spanish name kept verbatim from the TypeScript API
		{"Fecha_Limite", date},
		{"Estado", status},
		{"Fecha_Respuesta", date},
		// Dropped: Remitente and Contacto (identity and contact of the complainant), Descripcion
		// and Respuesta (complaints often describe health, family or whistle-blowing).
	}},
	{Slug: "lecciones", Fields: []NamedPolicy{
		{"ID_Leccion", recordID("Id of the lesson.")},
		{"Fecha", date},
		{"Territorio", territory},
		{"Tema", text("Subject of the lesson, a short phrase.")},
		{"Actor", actor},
		{"Que_Paso", text("What happened; names and contact data are replaced.")},
		{"Por_Que", text("Why it happened; names and contact data are replaced.")},
		{"Aprendido", text("What was learned; names and contact data are replaced.")},
		{"Registro_Relacionado", clear("Reference to a record, not a person.")},
	}},
}

// StoredModules gives the stored module name of each slug, to find the project's known names in
// the database.
var StoredModules = map[string]string{
	"actores":       "Actores",
	"eventos":       "Eventos",
	"demandas":      "Demandas", //nolint:misspell // Spanish name kept verbatim from the TypeScript API
	"compromisos":   "Compromisos",
	"narrativas":    "Narrativas", //nolint:misspell // Spanish name kept verbatim from the TypeScript API
	"fuentes":       "Fuentes",
	"alertas":       "Alertas",
	"acciones":      "Acciones",
	"directorio":    "Directorio_Territorial",
	"intereses":     "Intereses",
	"dialogos":      "Dialogos",
	"oportunidades": "Oportunidades",
	"hechos":        "Hechos_Compartidos",
	"aarc":          "Evaluaciones_AARC",
	"buzon":         "Buzon",
	"lecciones":     "Lecciones_Territoriales",
}

// TitleFields gives the field each module's display title comes from; its policy treats the title
// too.
var TitleFields = map[string]string{
	"actores":       "Nombre_Actor/Organizacion", //nolint:misspell // Spanish name kept verbatim from the TypeScript API
	"eventos":       "Descripcion_Hecho",
	"demandas":      "Descripcion", //nolint:misspell // Spanish name kept verbatim from the TypeScript API
	"compromisos":   "Descripcion",
	"narrativas":    "Descripcion", //nolint:misspell // Spanish name kept verbatim from the TypeScript API
	"fuentes":       "Archivo_Fuente",
	"alertas":       "Causa",
	"acciones":      "Accion",
	"directorio":    "Nombre",
	"intereses":     "Actor",
	"dialogos":      "Proceso",
	"oportunidades": "Oportunidad",
	"hechos":        "Asunto",
	"aarc":          "Actor_Proceso",
	"buzon":         "Asunto",
	"lecciones":     "Aprendido",
}

// NeverAllowed matches the field names that must never appear in FieldPolicies (checked by a test).
var NeverAllowed = regexp.MustCompile(`(?i)posici|postura|opini|tono|etni|raza|salud|enferm|discapac|relig|sindic|ingres|salari|sueldo|biometr|huella|telef|celular|correo|e?mail|dni|remitente|contacto`)

var policyIndex = func() map[string]map[string]FieldPolicy {
	index := make(map[string]map[string]FieldPolicy, len(FieldPolicies))
	for _, module := range FieldPolicies {
		fields := make(map[string]FieldPolicy, len(module.Fields))
		for _, f := range module.Fields {
			fields[f.Field] = f.Policy
		}
		index[module.Slug] = fields
	}
	return index
}()

// PolicyFor is the treatment of one field; false when it is not allowed (or the module has no list).
func PolicyFor(slug, field string) (FieldPolicy, bool) {
	policy, ok := policyIndex[slug][field]
	return policy, ok
}

// listSeparator is how a names field separates its people: commas, semicolons, slashes, «y»/«e».
var listSeparator = compile(`[~]*(?:[,;\n/&]|[~]+(?i:y)[~]+|[~]+(?i:e)[~]+)[~]*`)

// SplitList is value.split(LIST_SEPARATOR).
func SplitList(value string) []string {
	var out []string
	cursor := 0
	for _, m := range listSeparator.FindAllStringIndex(value, -1) {
		out = append(out, value[cursor:m[0]])
		cursor = m[1]
	}
	return append(out, value[cursor:])
}

// NameSource is where the project's own people and organisations are written, to find them in free
// text.
type NameSource struct {
	Field  string
	Entity PseudonymKind
	// List says the field holds several people, split with SplitList.
	List bool
}

// NameSources lists them. A person field has the same name in every module, so a source is read in
// all of them, also in modules and fields that are never sent: a name stored anywhere in SIPGES is
// a known name. Remitente is never sent, but its names must still be replaced inside free text.
var NameSources = func() []NameSource {
	var sources []NameSource
	add := func(source NameSource) {
		for i := range sources {
			if sources[i].Field == source.Field {
				sources[i] = source
				return
			}
		}
		sources = append(sources, source)
	}
	for _, module := range FieldPolicies {
		for _, f := range module.Fields {
			if f.Policy.Kind == PolicyName || f.Policy.Kind == PolicyNames {
				add(NameSource{f.Field, f.Policy.Entity, f.Policy.Kind == PolicyNames})
			}
		}
	}
	add(NameSource{"Remitente", Persona, false})
	return sources
}()

//nolint:misspell // The outlines are Spanish text kept verbatim from the TypeScript API.
package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
)

// The Word report outlines of reports.ts. They read what the engines answered, as the TypeScript
// functions read the engines' results, and the stored records for the strategic report.

// ReportKind names one of the Word reports.
type ReportKind string

// The Word reports.
const (
	ReportSituational ReportKind = "situational"
	ReportIntegrated  ReportKind = "integrated"
	ReportConsensus   ReportKind = "consensus"
	ReportStrategic   ReportKind = "strategic"
)

// ReportFilenames are REPORT_FILENAMES.
var ReportFilenames = map[ReportKind]string{
	ReportSituational: "SIPGES_Analisis_Situacional.docx",
	ReportIntegrated:  "SIPGES_RC19_Analisis_Integrado.docx",
	ReportConsensus:   "SIPGES_Motor_Valor_Consenso.docx",
	ReportStrategic:   "SIPGES_Informe_Estrategico.docx",
}

// BlockKind is the kind of a report block (@sipges/kernel report.ts). The analytics reports use
// no table block.
type BlockKind string

// The block kinds the reports use.
const (
	BlockTitle     BlockKind = "title"
	BlockHeading   BlockKind = "heading"
	BlockParagraph BlockKind = "paragraph"
	BlockBullet    BlockKind = "bullet"
)

// ReportBlock is one block of a format-neutral report outline.
type ReportBlock struct {
	Kind  BlockKind
	Level int // 1–3, headings only
	Text  string
}

func title(text string) ReportBlock     { return ReportBlock{Kind: BlockTitle, Text: text} }
func paragraph(text string) ReportBlock { return ReportBlock{Kind: BlockParagraph, Text: text} }
func bullet(text string) ReportBlock    { return ReportBlock{Kind: BlockBullet, Text: text} }
func heading(level int, text string) ReportBlock {
	return ReportBlock{Kind: BlockHeading, Level: level, Text: text}
}

// object is a decoded JSON object whose values stay raw.
type object map[string]json.RawMessage

func objects(raw json.RawMessage) ([]object, error) {
	var out []object
	err := json.Unmarshal(raw, &out)
	return out, err
}

func rawList(raw json.RawMessage) ([]json.RawMessage, error) {
	var out []json.RawMessage
	err := json.Unmarshal(raw, &out)
	return out, err
}

// pyGet is pyGet: the stored value even when null, the fallback only when the key is absent.
func (o object) pyGet(key string, fallback json.RawMessage) json.RawMessage {
	if value, ok := o[key]; ok {
		return value
	}
	return fallback
}

var (
	emptyString = json.RawMessage(`""`)
	jsonNull    = json.RawMessage(`null`)
)

// outline writes one report, keeping the first error so each block reads as its TypeScript line.
type outline struct {
	blocks []ReportBlock
	err    error
}

func (o *outline) add(blocks ...ReportBlock) { o.blocks = append(o.blocks, blocks...) }

// text is a value inside a template literal: strings as they are, numbers as String(n).
func (o *outline) text(v json.RawMessage) string {
	v = bytes.TrimSpace(v)
	if len(v) == 0 {
		return "undefined"
	}
	switch v[0] {
	case 'n':
		return "null"
	case 't':
		return "true"
	case 'f':
		return "false"
	}
	return o.py(v)
}

func (o *outline) py(v json.RawMessage) string {
	s, err := PyStr(v)
	if err != nil && o.err == nil {
		o.err = err
	}
	return s
}

func (o *outline) truthy(v json.RawMessage) bool {
	ok, err := PyTruthy(v)
	if err != nil && o.err == nil {
		o.err = err
	}
	return ok
}

func (o *outline) list(raw json.RawMessage) []json.RawMessage {
	items, err := rawList(raw)
	if err != nil && o.err == nil {
		o.err = err
	}
	return items
}

func (o *outline) objects(raw json.RawMessage) []object {
	items, err := objects(raw)
	if err != nil && o.err == nil {
		o.err = err
	}
	return items
}

// join is Array.prototype.join over strings: null and undefined print nothing.
func (o *outline) join(raw json.RawMessage, sep string) string {
	items := o.list(raw)
	parts := make([]string, len(items))
	for i, item := range items {
		if !bytes.Equal(bytes.TrimSpace(item), jsonNull) {
			parts[i] = o.text(item)
		}
	}
	return strings.Join(parts, sep)
}

// bullets is items.map(bullet).
func (o *outline) bullets(raw json.RawMessage) {
	for _, item := range o.list(raw) {
		o.add(bullet(o.text(item)))
	}
}

func (o *outline) source(x object) string {
	if o.truthy(x.pyGet("Fuente_ID", jsonNull)) {
		return o.py(x["Fuente_ID"])
	}
	return "no consignada"
}

// SituationalReport is situationalReport over buildSituational's answer.
func SituationalReport(analysis json.RawMessage) ([]ReportBlock, error) {
	var d object
	if err := json.Unmarshal(analysis, &d); err != nil {
		return nil, err
	}
	var counts object
	if err := json.Unmarshal(d["counts"], &counts); err != nil {
		return nil, err
	}
	o := &outline{}
	o.add(title("INFORME DE ANÁLISIS SITUACIONAL"),
		paragraph(o.py(d["project_name"])+" | Corte: "+o.text(d["generated_at"])),
		paragraph("Documento generado automáticamente por SIPGES (Sistema Inteligente de Predicción y GEStión Social). BORRADOR SUJETO A REVISIÓN Y VALIDACIÓN."),
		heading(1, "1. Resumen ejecutivo"),
		paragraph("Se integraron "+o.text(counts["eventos"])+" eventos, "+o.text(counts["actores"])+" actores, "+o.text(d["demandas_pendientes"])+
			" demandas pendientes y "+o.text(d["alertas_activas"])+" alertas activas en la Base Maestra del proyecto. Las cifras indican registros, no hechos necesariamente corroborados."),
		heading(1, "2. Diagnóstico de la situación"))
	o.bullets(d["observaciones"])
	o.add(heading(1, "3. Territorios con eventos registrados"))
	for _, entry := range o.list(d["territorios"]) {
		pair := o.list(entry)
		if len(pair) != 2 {
			return nil, errors.New("analytics: a territory is a name and a count")
		}
		o.add(bullet(o.text(pair[0]) + ": " + o.text(pair[1]) + " registros"))
	}
	o.add(heading(1, "4. Demandas y asuntos relevantes"))
	for _, x := range o.objects(d["demandas_abiertas"]) {
		o.add(bullet("[" + o.text(x["id"]) + "] " + o.py(x.pyGet("Tema", emptyString)) + " — " +
			o.py(x.pyGet("Descripcion", emptyString)) + " (Fuente: " + o.source(x) + ")"))
	}
	o.add(heading(1, "5. Alertas prioritarias"))
	for _, x := range o.objects(d["alertas_prioritarias"]) {
		o.add(bullet("[" + o.text(x["id"]) + "] " + o.py(x.pyGet("Nivel_Preliminar", json.RawMessage(`"Sin nivel"`))) + ": " +
			o.py(x.pyGet("Causa", emptyString)) + " (Fuente: " + o.source(x) + ")"))
	}
	o.add(heading(1, "6. Escenarios condicionales"))
	for _, x := range o.objects(d["escenarios"]) {
		o.add(bullet(o.text(x["nombre"]) + ": " + o.text(x["supuesto"])))
	}
	o.add(heading(1, "7. Recomendaciones"))
	o.bullets(d["recomendaciones"])
	o.add(heading(1, "8. Alcances y limitaciones"))
	o.bullets(d["limitations"])
	o.add(paragraph("Preparado por: Sistema SIPGES | Revisión técnica: __________________ | Fecha de validación: ______________"))
	return o.blocks, o.err
}

// IntegratedReport is integratedReport over integratedAnalysis's answer.
func IntegratedReport(analysis json.RawMessage) ([]ReportBlock, error) {
	var d object
	if err := json.Unmarshal(analysis, &d); err != nil {
		return nil, err
	}
	o := &outline{}
	o.add(title("SIPGES | Análisis integrado RC 1.9"),
		paragraph("Proyecto "+o.text(d["project_id"])+" · Corte "+o.text(d["generated_at"])),
		paragraph("DOCUMENTO AUTOMÁTICO EN BORRADOR. Los vínculos no están confirmados; requiere revisión profesional y contrastación de fuentes."),
		heading(1, "1. Cruces candidatos entre módulos"))
	links := o.objects(d["candidate_links"])
	if len(links) == 0 {
		o.add(paragraph("Sin coincidencias verificables suficientes en los registros disponibles."))
	}
	for _, x := range links {
		o.add(bullet(o.text(x["origen"]) + " ↔ " + o.text(x["destino"]) + " | " + o.text(x["criterio"]) +
			" | términos: " + o.join(x["terminos_compartidos"], ", ")))
	}
	o.add(heading(1, "2. Plan de acción propuesto"))
	plan := o.objects(d["action_plan"])
	if len(plan) == 0 {
		o.add(paragraph("Sin acciones generadas; la ausencia de registros no demuestra ausencia de riesgo."))
	}
	for _, x := range plan {
		o.add(heading(2, o.text(x["numero"])+". "+o.text(x["objetivo"])),
			paragraph("Acción: "+o.text(x["accion"])+"\nFundamento: "+o.text(x["fundamento"])+"\nRegistros: "+o.join(x["registros"], ", ")+
				"\nResponsable: por asignar | Estado: no aprobado"))
	}
	o.add(heading(1, "3. Escenarios condicionales (no predicciones)"))
	for _, x := range o.objects(d["scenarios"]) {
		o.add(heading(2, o.text(x["tipo"])), paragraph(o.text(x["supuesto"])),
			paragraph("Indicadores: "+o.join(x["indicadores_a_observar"], ", ")))
	}
	o.add(heading(1, "4. Alcances y salvaguardas"))
	o.bullets(d["limitations"])
	o.add(paragraph("Revisado por: __________________  Fecha: _________________"))
	return o.blocks, o.err
}

var consensusFields = [][2]string{
	{"Enfoque", "tipo"},
	{"Hallazgo de registro", "motivo"},
	{"Acción sugerida", "accion_sugerida"},
	{"Procedencia", "origen"},
	{"Nivel orientativo", "prioridad_orientativa"},
}

// ConsensusReport is consensusReport over automatedConsensus's answer.
func ConsensusReport(analysis json.RawMessage) ([]ReportBlock, error) {
	var d object
	if err := json.Unmarshal(analysis, &d); err != nil {
		return nil, err
	}
	o := &outline{}
	o.add(title("SIPGES | Motor de valor y consenso"),
		paragraph("Proyecto: "+o.text(d["project_id"])+" · Corte: "+o.text(d["generated_at"])),
		paragraph("BORRADOR AUTOMATIZADO: recomendaciones basadas en registros y reglas. REVISIÓN OBLIGATORIA."))
	for i, x := range o.objects(d["recommendations"]) {
		o.add(heading(2, strconv.Itoa(i+1)+". "+o.text(x["titulo"])))
		for _, field := range consensusFields {
			o.add(paragraph(field[0] + ": " + o.text(x[field[1]])))
		}
	}
	o.add(heading(1, "Limitaciones"))
	o.bullets(d["limitations"])
	o.add(paragraph("Revisó: ______________________ Fecha: __________"))
	return o.blocks, o.err
}

// strategicSectionLimit is records[key].slice(0, 40).
const strategicSectionLimit = 40

var strategicSections = []struct {
	title, module string
	fields        []string
}{
	{"2. Mapeo de intereses", "Intereses", []string{"Actor", "Posicion", "Interes", "Preocupacion", "Fuente_ID"}},
	{"3. Procesos de diálogo y acuerdos", "Dialogos", []string{"Proceso", "Participantes", "Tema", "Estado", "Proximo_Paso"}},
	{"4. Valor compartido", "Oportunidades", []string{"Oportunidad", "Beneficiarios", "Viabilidad", "Estado", "Responsable"}},
	{"5. Hechos compartidos y controversias", "Hechos_Compartidos", []string{"Asunto", "Estado", "Versiones", "Fuente_ID", "Accion_Verificacion"}},
	{"6. Evaluaciones AARC", "Evaluaciones_AARC", []string{"Actor_Proceso", "Reconocimiento", "Agencia", "Reciprocidad", "Claridad", "Evidencia"}},
}

// StrategicReport is strategicReport over the extended records and the answers of
// strategicAssessment and buildSituational.
func StrategicReport(records RecordsByModule, assessment, situational json.RawMessage) ([]ReportBlock, error) {
	var report, situation object
	if err := json.Unmarshal(assessment, &report); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(situational, &situation); err != nil {
		return nil, err
	}
	o := &outline{}
	o.add(title("SIPGES | Informe estratégico territorial"),
		paragraph(o.py(situation["project_name"])+" | Corte: "+o.text(report["generated_at"])),
		paragraph("BORRADOR AUTOMATIZADO — REQUIERE REVISIÓN Y APROBACIÓN. No sustituye decisiones institucionales."),
		heading(1, "1. Situación social documentada"))
	o.bullets(situation["observaciones"])
	for _, section := range strategicSections {
		o.add(heading(1, section.title))
		rows := records.Of(section.module)
		if len(rows) == 0 {
			o.add(paragraph("Sin registros. No es posible emitir conclusiones sobre este componente."))
		}
		if len(rows) > strategicSectionLimit {
			rows = rows[:strategicSectionLimit]
		}
		for _, row := range rows {
			var record object
			if err := json.Unmarshal(row.Payload, &record); err != nil {
				return nil, err
			}
			var parts []string
			for _, field := range section.fields {
				if o.truthy(record.pyGet(field, jsonNull)) {
					parts = append(parts, field+": "+o.py(record[field]))
				}
			}
			o.add(bullet("[" + row.ID + "] " + strings.Join(parts, " | ")))
		}
	}
	o.add(heading(1, "7. Alertas metodológicas"))
	o.bullets(report["limitations"])
	o.add(paragraph("Validado por: _________________________    Fecha: __________________"))
	return o.blocks, o.err
}

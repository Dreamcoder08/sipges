package domain

import "strconv"

// The analysis answer and the Word report outline of lab-report.ts.

// AnalysisVersion is ANALYSIS_VERSION.
const AnalysisVersion = "2.1"

// AnalysisMethod is ANALYSIS_METHOD.
const AnalysisMethod = "Detección léxica local por categorías; sin modelo generativo, OCR ni búsqueda semántica."

// AnalysisLimitations is ANALYSIS_LIMITATIONS.
var AnalysisLimitations = []string{
	"Los fragmentos son hallazgos candidatos, NO hechos corroborados.",
	"No se infiere la intención, legitimidad ni delito de personas o colectivos.",
	"La coincidencia de palabras no demuestra un compromiso, acuerdo ni conflicto.",
	"El documento no se almacena y ninguna sugerencia se escribe automáticamente en la base de datos.",
	"Suba solo documentos autorizados para el proyecto activo y evite datos personales innecesarios.",
}

// CompareMethod is COMPARE_METHOD.
const CompareMethod = "Comparación léxica local, misma categoría y términos distintivos compartidos; no comprensión semántica."

// CompareLimitations is COMPARE_LIMITATIONS.
var CompareLimitations = []string{
	"Las coincidencias no prueban contradicciones.",
	"Confirmar identidad de actores, fechas y validez documental manualmente.",
	"Los documentos no se guardan ni se integran automáticamente a la base maestra.",
}

// LabReportFilename is LAB_REPORT_FILENAME.
const LabReportFilename = "SIPGES_RC20_Lectura_Documental.docx"

// DocumentAnalysis is DocumentAnalysis, with its JSON keys in the TypeScript order.
type DocumentAnalysis struct {
	Version         string           `json:"version"`
	ProjectID       string           `json:"project_id"`
	Filename        string           `json:"filename"`
	SHA256          string           `json:"sha256"`
	GeneratedAt     string           `json:"generated_at"`
	TextSections    int              `json:"text_sections"`
	Items           []Finding        `json:"items"`
	Themes          ThemeCounts      `json:"themes"`
	Recommendations []Recommendation `json:"recommendations"`
	Method          string           `json:"method"`
	Limitations     []string         `json:"limitations"`
}

// BlockKind is the kind of a report block (@sipges/kernel report.ts). Tables are not part of
// the lab report, so this port has no table block.
type BlockKind string

// The block kinds the lab report uses.
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

// LabReport is labReport: the outline of app.py `document_lab_report`.
func LabReport(a DocumentAnalysis) []ReportBlock {
	p := func(text string) ReportBlock { return ReportBlock{Kind: BlockParagraph, Text: text} }
	h := func(level int, text string) ReportBlock {
		return ReportBlock{Kind: BlockHeading, Level: level, Text: text}
	}
	blocks := []ReportBlock{
		{Kind: BlockTitle, Text: "SIPGES (Sistema Inteligente de Predicción y GEStión Social) RC 2.0 | Informe de lectura documental"},
		p("PROTOTIPO · Material para revisión técnica, no informe oficial"),
		p("filename: " + a.Filename),
		p("project_id: " + a.ProjectID),
		p("sha256: " + a.SHA256),
		p("generated_at: " + a.GeneratedAt),
		p("method: " + a.Method),
		h(1, "Áreas temáticas y acciones propuestas"),
	}
	for _, r := range a.Recommendations {
		blocks = append(blocks, h(2, r.Tema),
			p(strconv.FormatInt(r.HallazgosCandidato, 10)+" fragmentos candidatos. "+r.Accion))
	}
	blocks = append(blocks, h(1, "Fragmentos con trazabilidad"))
	for _, x := range a.Items {
		blocks = append(blocks, h(3, x.ID+" — "+x.Tema+" ("+x.Ubicacion+")"), p(x.Fragmento), p(x.AccionSugerida))
	}
	blocks = append(blocks, h(1, "Limitaciones y revisión"))
	for _, l := range a.Limitations {
		blocks = append(blocks, ReportBlock{Kind: BlockBullet, Text: l})
	}
	return blocks
}

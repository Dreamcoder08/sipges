//nolint:misspell // Spanish themes, fields and messages, verbatim from the TypeScript API.
package domain

import (
	"slices"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"

	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// The document lab's lexical reading (insights.ts, app.py:1704-1760): every text section is
// split into sentences and matched against seven theme vocabularies. Matches are candidate
// findings for human review, never facts.

// docTerm is one theme of DOC_TERMS, in the object's key order (the order themes are tried).
type docTerm struct {
	theme string
	words []string
}

var docTerms = []docTerm{
	{"Representatividad y gobernanza", []string{"representatividad", "mandato", "directiva", "elección", "asamblea", "comunidad", "vigencia", "junta"}},
	{"Demandas e intereses", []string{"demanda", "solicitud", "preocupación", "empleo", "proveedores", "capacitación", "petición", "reclamo"}},
	{"Compromisos y trazabilidad", []string{"compromiso", "acuerdo", "responsable", "plazo", "seguimiento", "cumplimiento", "acta"}},
	{"Controversias y hechos compartidos", []string{"controversia", "versión", "evidencia", "verificación", "fuente", "denuncia", "cuestionamiento"}},
	{"Diálogo y construcción de consensos", []string{"diálogo", "reunión", "negociación", "participación", "consenso", "facilitación", "mesa"}},
	{"Oportunidades de valor compartido", []string{"oportunidad", "desarrollo", "inversión", "beneficio", "contratación", "servicios", "productiva"}},
	{"Territorio y ambiente", []string{"territorio", "ambiental", "agua", "suelo", "salud", "impacto", "área de influencia"}},
}

// docActions is DOC_ACTIONS.
var docActions = map[string]string{
	"Representatividad y gobernanza":      "Comprobar mandato, vigencia y fuentes de representación antes de formalizar interlocución.",
	"Demandas e intereses":                "Diferenciar demandas explícitas de intereses expresamente documentados y evitar inferir motivaciones.",
	"Compromisos y trazabilidad":          "Contrastar actas, responsables y fechas antes de registrar compromisos como confirmados.",
	"Controversias y hechos compartidos":  "Abrir ficha de hechos por verificar, reunir fuentes y registrar versiones sin dar por probada ninguna.",
	"Diálogo y construcción de consensos": "Evaluar condiciones de participación informada y posibles preguntas para una agenda de diálogo.",
	"Oportunidades de valor compartido":   "Evaluar beneficios potenciales, restricciones, responsable institucional y viabilidad antes de prometer acciones.",
	"Territorio y ambiente":               "Solicitar contraste técnico territorial y distinguir percepciones de impactos confirmados.",
}

// DocAction is DOC_ACTIONS[theme] ?? ”.
func DocAction(theme string) string { return docActions[theme] }

// TextChunk is one located text section, e.g. `Página 3` or `Tabla 1, fila 2`.
type TextChunk struct {
	Location string
	Text     string
}

// Finding is one candidate finding; the JSON keys are those of the TypeScript API.
type Finding struct {
	ID             string   `json:"id"`
	Tema           string   `json:"tema"`
	Ubicacion      string   `json:"ubicacion"`
	Fragmento      string   `json:"fragmento"`
	Terminos       []string `json:"terminos"`
	AccionSugerida string   `json:"accion_sugerida"`
	Estado         string   `json:"estado"`
}

// Limits of documentInsights.
const (
	MaxFindings         = 75
	MaxFindingsPerTheme = 12
	excerptLength       = 480
	minSegmentLength    = 20
	maxTerms            = 6
)

// TakeCodePoints is takeCodePoints: Python's s[:n], counting code points.
func TakeCodePoints(text string, count int) string {
	if count <= 0 {
		return ""
	}
	n := 0
	for i := range text {
		if n == count {
			return text[:i]
		}
		n++
	}
	return text
}

// FoldASCII is foldAscii: NFKD, then every non-ASCII code point removed.
func FoldASCII(text string) string {
	decomposed := norm.NFKD.String(text)
	var b strings.Builder
	b.Grow(len(decomposed))
	for i := 0; i < len(decomposed); i++ {
		if decomposed[i] < utf8.RuneSelf {
			b.WriteByte(decomposed[i])
		}
	}
	return b.String()
}

type foldedTerm struct {
	theme string
	words []string
	folds []string
}

var foldedTerms = func() []foldedTerm {
	out := make([]foldedTerm, len(docTerms))
	for i, t := range docTerms {
		out[i] = foldedTerm{theme: t.theme, words: t.words}
		for _, w := range t.words {
			out[i].folds = append(out[i].folds, FoldASCII(w))
		}
	}
	return out
}()

// collapseWhitespace is text.split(/\s+/u).filter(Boolean).join(' ').
func collapseWhitespace(text string) string {
	return strings.Join(strings.FieldsFunc(text, js.IsJSSpace), " ")
}

// splitSegments is text.split(/(?<=[.!?])\s+|\n+/u): a run of whitespace right after a
// sentence end, or a run of line feeds, separates segments.
func splitSegments(text string) []string {
	var out []string
	start, i := 0, 0
	for i < len(text) {
		r, size := utf8.DecodeRuneInString(text[i:])
		end := -1
		if js.IsJSSpace(r) && i > 0 && strings.IndexByte(".!?", text[i-1]) >= 0 {
			end = i
			for end < len(text) {
				s, n := utf8.DecodeRuneInString(text[end:])
				if !js.IsJSSpace(s) {
					break
				}
				end += n
			}
		} else if r == '\n' {
			end = i
			for end < len(text) && text[end] == '\n' {
				end++
			}
		}
		if end < 0 {
			i += size
			continue
		}
		out = append(out, text[start:i])
		start, i = end, end
	}
	return append(out, text[start:])
}

// Insights are documentInsights' findings and theme counts (themes in first-seen order).
type Insights struct {
	Items  []Finding
	Themes ThemeCounts
}

// DocumentInsights is documentInsights: at most MaxFindings findings, MaxFindingsPerTheme per
// theme, numbered H001… in document order.
func DocumentInsights(chunks []TextChunk) Insights {
	items := []Finding{}
	counts := map[string]int{}
	var order []string
	for _, chunk := range chunks {
		if len(items) == MaxFindings {
			break
		}
		for _, raw := range splitSegments(chunk.Text) {
			if len(items) == MaxFindings {
				break
			}
			segment := collapseWhitespace(raw)
			if utf8.RuneCountInString(segment) < minSegmentLength {
				continue
			}
			simplified := FoldASCII(js.LowerJS(segment))
			for _, t := range foldedTerms {
				var hits []string
				for i, folded := range t.folds {
					if strings.Contains(simplified, folded) {
						hits = append(hits, t.words[i])
					}
				}
				themeCount := counts[t.theme]
				if len(hits) > 0 && themeCount < MaxFindingsPerTheme && len(items) < MaxFindings {
					items = append(items, Finding{
						ID:             findingID(len(items) + 1),
						Tema:           t.theme,
						Ubicacion:      chunk.Location,
						Fragmento:      TakeCodePoints(segment, excerptLength),
						Terminos:       hits[:min(len(hits), maxTerms)],
						AccionSugerida: docActions[t.theme],
						Estado:         "Candidato no verificado",
					})
					if themeCount == 0 {
						order = append(order, t.theme)
					}
					counts[t.theme] = themeCount + 1
				}
			}
		}
	}
	out := Insights{Items: items}
	for _, theme := range order {
		out.Themes.Add(theme, int64(counts[theme]))
	}
	return out
}

// findingID is `H${String(n).padStart(3, '0')}`.
func findingID(n int) string {
	s := js.JSNumber(float64(n))
	for len(s) < 3 {
		s = "0" + s
	}
	return "H" + s
}

// Recommendation is one entry of recommendationsFor.
type Recommendation struct {
	Tema               string `json:"tema"`
	Accion             string `json:"accion"`
	HallazgosCandidato int64  `json:"hallazgos_candidatos"`
}

// RecommendationsFor is recommendationsFor: themes by finding count, ties in first-seen order.
func RecommendationsFor(themes ThemeCounts) []Recommendation {
	out := make([]Recommendation, 0, themes.Len())
	for _, theme := range themes.Keys() {
		n, _ := themes.Get(theme)
		out = append(out, Recommendation{Tema: theme, Accion: docActions[theme], HallazgosCandidato: n})
	}
	slices.SortStableFunc(out, func(a, b Recommendation) int {
		switch {
		case a.HallazgosCandidato > b.HallazgosCandidato:
			return -1
		case a.HallazgosCandidato < b.HallazgosCandidato:
			return 1
		}
		return 0
	})
	return out
}

var fingerprintStopwords = map[string]bool{
	"sobre": true, "entre": true, "desde": true, "hasta": true, "estos": true, "estas": true,
	"donde": true, "para": true, "tiene": true, "como": true, "documento": true, "proyecto": true,
	"social": true, "sechura": true, "tambien": true, "dicho": true, "segun": true,
}

// wordSet is a Set of strings in insertion order.
type wordSet struct {
	order []string
	has   map[string]bool
}

func (s *wordSet) add(w string) {
	if s.has == nil {
		s.has = map[string]bool{}
	}
	if !s.has[w] {
		s.has[w] = true
		s.order = append(s.order, w)
	}
}

// fingerprint is fingerprint: distinctive words of five or more ASCII letters or digits,
// matched left to right as /[a-z0-9]{5,}/g does.
func fingerprint(text string) wordSet {
	folded := FoldASCII(js.LowerJS(text))
	var set wordSet
	for i := 0; i < len(folded); {
		j := i
		for j < len(folded) && (folded[j] >= 'a' && folded[j] <= 'z' || folded[j] >= '0' && folded[j] <= '9') {
			j++
		}
		if j-i >= 5 && !fingerprintStopwords[folded[i:j]] {
			set.add(folded[i:j])
		}
		if j == i {
			j++
		}
		i = j
	}
	return set
}

// Excerpt is one side of a comparison candidate.
type Excerpt struct {
	Ubicacion string `json:"ubicacion"`
	Fragmento string `json:"fragmento"`
}

// ComparisonCandidate is one pair of same-theme findings.
type ComparisonCandidate struct {
	Tema               string   `json:"tema"`
	A                  Excerpt  `json:"a"`
	B                  Excerpt  `json:"b"`
	TerminosComunes    []string `json:"terminos_comunes"`
	CoincidenciaLexica float64  `json:"coincidencia_lexica"`
	Tipo               string   `json:"tipo"`
	Advertencia        string   `json:"advertencia"`
}

// Limits of compareFindings.
const (
	minSimilarity  = 0.11
	MaxComparisons = 40
	maxCommon      = 10
)

// CompareFindings is compareFindings: same-theme pairs sharing at least two distinctive words
// with a Jaccard index of at least 0.11, most similar first (stable), at most MaxComparisons,
// and how many there were.
func CompareFindings(a, b []Finding) ([]ComparisonCandidate, int) {
	candidates := []ComparisonCandidate{}
	right := make([]wordSet, len(b))
	for i, ib := range b {
		right[i] = fingerprint(ib.Fragmento)
	}
	for _, ia := range a {
		fa := fingerprint(ia.Fragmento)
		if len(fa.order) == 0 {
			continue
		}
		for j, ib := range b {
			if ia.Tema != ib.Tema {
				continue
			}
			fb := right[j]
			var overlap []string
			for _, w := range fa.order {
				if fb.has[w] {
					overlap = append(overlap, w)
				}
			}
			if len(overlap) < 2 {
				continue
			}
			union := len(fa.order)
			for _, w := range fb.order {
				if !fa.has[w] {
					union++
				}
			}
			similarity := float64(len(overlap)) / float64(max(1, union))
			if similarity < minSimilarity {
				continue
			}
			slices.Sort(overlap) // ASCII words: UTF-16 and byte order agree
			candidates = append(candidates, ComparisonCandidate{
				Tema:               ia.Tema,
				A:                  Excerpt{Ubicacion: ia.Ubicacion, Fragmento: ia.Fragmento},
				B:                  Excerpt{Ubicacion: ib.Ubicacion, Fragmento: ib.Fragmento},
				TerminosComunes:    overlap[:min(len(overlap), maxCommon)],
				CoincidenciaLexica: js.RoundJS(similarity*100) / 100,
				Tipo:               "Coincidencia temática; verificar diferencias entre versiones",
				Advertencia:        "No constituye contradicción demostrada ni acuerdo confirmado.",
			})
		}
	}
	slices.SortStableFunc(candidates, func(x, y ComparisonCandidate) int {
		switch {
		case x.CoincidenciaLexica > y.CoincidenciaLexica:
			return -1
		case x.CoincidenciaLexica < y.CoincidenciaLexica:
			return 1
		}
		return 0
	})
	return candidates[:min(len(candidates), MaxComparisons)], len(candidates)
}

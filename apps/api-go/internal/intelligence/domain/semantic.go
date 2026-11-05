//nolint:misspell // Spanish themes and references, verbatim from the TypeScript API.
package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"regexp"
	"slices"
	"strings"
	"unicode"
)

// The analysis modes and the bounds of alerts.ts and text-analysis.ts.
const (
	ModeAutomatic = "automatic"
	ModeSemantic  = "semantic"
	ModeRules     = "rules"

	semanticThreshold = 0.38
	maxMatches        = 5
)

// Concept is one theme and the reference text its embedding is computed from.
type Concept struct {
	Theme     string
	Reference string
}

// SemanticConcepts is SEMANTIC_CONCEPTS of text-analysis.ts, in its order. The references are
// written in the code: no tenant data is in them.
var SemanticConcepts = []Concept{
	{"Ambiente y agua", "Preocupaciones comunitarias por calidad de agua, contaminación ambiental, impacto ecológico y salud ambiental."},
	{"Gobernanza y representación", "Legitimidad de dirigencias comunales, decisiones de asamblea, elecciones y representación institucional."},
	{"Territorio y uso de tierras", "Acceso a predios, servidumbres, concesiones mineras, propiedad, límites y uso de tierras."},
	{"Trabajo y economía local", "Oportunidades de empleo, contratación local, proveedores, ingresos y beneficios económicos."},
	{"Diálogo y compromisos", "Solicitudes de reunión, acuerdos pendientes, incumplimientos, mesas de diálogo y negociación."},
	{"Movilización social", "Convocatorias públicas de marcha, protestas, paros y reuniones colectivas de protesta."},
	{"Seguridad y emergencia", "Accidentes operacionales, riesgos de seguridad física, emergencias y evacuación."},
}

// IsAnalysisMode says mode is one of ANALYSIS_MODES.
func IsAnalysisMode(mode string) bool {
	return mode == ModeAutomatic || mode == ModeSemantic || mode == ModeRules
}

var publicURL = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)`)

// IsPublicHTTPURL is isPublicHttpUrl: the URL has an http(s) scheme and a network location.
func IsPublicHTTPURL(url string) bool {
	match := publicURL.FindStringSubmatch(url)
	if match == nil || match[2] == "" {
		return false
	}
	scheme := strings.ToLower(match[1])
	return scheme == "http" || scheme == "https"
}

// TrimJS is String.prototype.trim.
func TrimJS(s string) string { return strings.TrimFunc(s, isJSSpace) }

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', '\u2028', '\u2029', '\ufeff':
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

// Cosine is cosine of text-analysis.ts; vectors of different length are unrelated.
func Cosine(a, b []float64) float64 {
	if len(a) != len(b) {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		dot += a[i] * b[i]
		na += a[i] * a[i]
		nb += b[i] * b[i]
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}

// Match is one theme close in meaning to the text.
type Match struct {
	Theme      string  `json:"theme"`
	Similarity float64 `json:"similarity"`
	Reference  string  `json:"reference"`
}

// Rank compares content with concepts, the vectors of SemanticConcepts in order: those at the
// threshold or above, best first, ties in concept order, at most five.
func Rank(content []float64, concepts [][]float64) []Match {
	matches := []Match{}
	for i, concept := range SemanticConcepts {
		raw := Cosine(content, concepts[i])
		if raw >= semanticThreshold {
			matches = append(matches, Match{concept.Theme, math.Round(raw*1000) / 1000, concept.Reference})
		}
	}
	slices.SortStableFunc(matches, func(a, b Match) int {
		switch {
		case a.Similarity > b.Similarity:
			return -1
		case a.Similarity < b.Similarity:
			return 1
		}
		return 0
	})
	return matches[:min(len(matches), maxMatches)]
}

// Field is one key of a JSON object to set.
type Field struct {
	Key   string
	Value any
}

// Overlay writes an object as JavaScript's spread does: a key base already holds keeps its place
// with the new value, a new key goes last. Everything else keeps base's bytes.
func Overlay(base json.RawMessage, fields ...Field) (json.RawMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(base))
	if open, err := dec.Token(); err != nil || open != json.Delim('{') {
		return nil, errors.New("intelligence: the report is not an object")
	}
	pending := slices.Clone(fields)
	var out bytes.Buffer
	out.WriteByte('{')
	for dec.More() {
		token, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, ok := token.(string)
		if !ok {
			return nil, errors.New("intelligence: the report is not an object")
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		at := slices.IndexFunc(pending, func(f Field) bool { return f.Key == key })
		if at < 0 {
			if err := writeMember(&out, key, value); err != nil {
				return nil, err
			}
			continue
		}
		if err := writeMember(&out, key, pending[at].Value); err != nil {
			return nil, err
		}
		pending = slices.Delete(pending, at, at+1)
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("intelligence: text after the report")
	}
	for _, field := range pending {
		if err := writeMember(&out, field.Key, field.Value); err != nil {
			return nil, err
		}
	}
	out.WriteByte('}')
	return out.Bytes(), nil
}

func writeMember(out *bytes.Buffer, key string, value any) error {
	if out.Len() > 1 {
		out.WriteByte(',')
	}
	if err := writeJSON(out, key); err != nil {
		return err
	}
	out.WriteByte(':')
	if raw, ok := value.(json.RawMessage); ok {
		out.Write(raw)
		return nil
	}
	return writeJSON(out, value)
}

// writeJSON leaves <, > and & as they are, as JSON.stringify does.
func writeJSON(out *bytes.Buffer, value any) error {
	encoder := json.NewEncoder(out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return err
	}
	out.Truncate(out.Len() - 1) // the encoder's newline
	return nil
}

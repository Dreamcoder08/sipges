//nolint:misspell // Spanish record fields, modules and messages, verbatim from the TypeScript API.
package domain

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// SourceRecord is a stored record: module, id and its payload as decoded JSON.
type SourceRecord struct {
	Module  string
	ID      string
	Payload map[string]any
}

// Signal is a dated record that can form situations.
type Signal struct {
	Module   string
	ID       string
	Title    Text16
	Date     string // YYYY-MM-DD
	AgeDays  int
	Severity float64 // 1 normal, 1.5 high, 2 critical
	Topics   []string
	Actors   []string
	// Territory is empty when the record names none.
	Territory string
	// Tone is the folded tone of a narrative, empty otherwise.
	Tone string
}

type moduleSpec struct {
	dates, titles, actors, topics, severity, text []string
}

// LessonsModule holds the territorial lessons (docs/adr/0024 §4).
const LessonsModule = "Lecciones_Territoriales"

var moduleSpecs = map[string]moduleSpec{
	"Eventos": {
		dates:    []string{"Fecha"},
		titles:   []string{"Descripcion_Hecho", "Tipo_Evento"},
		actors:   []string{"Actor_Principal"},
		topics:   []string{"Tema", "Tipo_Evento"},
		severity: []string{"Relevancia_Preliminar", "Nivel_Preliminar"},
		text:     []string{"Descripcion_Hecho", "Tipo_Evento", "Observaciones"},
	},
	"Demandas": {
		dates: []string{"Fecha_Registro", "Fecha"}, titles: []string{"Tema", "Descripcion"},
		actors: []string{"Actor/Grupo"}, topics: []string{"Tema"}, severity: []string{"Prioridad"},
		text: []string{"Tema", "Descripcion"},
	},
	"Compromisos": {
		dates: []string{"Fecha"}, titles: []string{"Descripcion"},
		actors: []string{"Actor/Entidad", "Responsable"}, topics: []string{"Tema"},
		severity: []string{"Prioridad"}, text: []string{"Descripcion"},
	},
	"Narrativas": {
		dates: []string{"Fecha_Inicio", "Fecha_Observacion"}, titles: []string{"Tema", "Descripcion"},
		actors: []string{"Actor_Relacionado"}, topics: []string{"Tema"}, severity: []string{"Intensidad"},
		text: []string{"Tema", "Descripcion"},
	},
	"Alertas": {
		dates: []string{"Fecha"}, titles: []string{"Causa"},
		actors: []string{"Actor", "Actor_Relacionado"}, topics: []string{"Tema"},
		severity: []string{"Nivel_Preliminar", "Nivel"}, text: []string{"Causa", "Accion_Sugerida"},
	},
	"Dialogos": {
		dates: []string{"Fecha"}, titles: []string{"Proceso", "Tema"},
		actors: []string{"Participantes"}, topics: []string{"Tema"}, severity: nil,
		text: []string{"Tema", "Acuerdo"},
	},
	"Buzon": {
		dates: []string{"Fecha"}, titles: []string{"Asunto", "Descripcion"},
		actors: []string{"Actor_Relacionado"}, topics: []string{"Tema"}, severity: []string{"Prioridad"},
		text: []string{"Asunto", "Descripcion"},
	},
}

// Modules is every module the situations read: those that form situations, then the lessons.
var Modules = []string{"Eventos", "Demandas", "Compromisos", "Narrativas", "Alertas", "Dialogos", "Buzon", LessonsModule}

// TerritoryFields are the record fields that name a territory, in priority order.
var TerritoryFields = []string{"Territorio", "Comunidad", "Localidad", "Distrito"}

// generatedOrigin marks alerts SIPGES suggested itself: they never feed situations.
const generatedOrigin = "SIPGES"

type topicPattern struct {
	name    string
	pattern *regexp.Regexp
}

// topicPatterns is TOPIC_KEYWORDS in its order: a keyword matches at the start of a word.
var topicPatterns = func() []topicPattern {
	keywords := []struct {
		name  string
		words []string
	}{
		{"Empleo local", []string{"empleo", "trabajo", "mano de obra", "contratacion", "puestos"}},
		{"Agua", []string{"agua", "hidric", "pozo", "riego", "manantial"}},
		{"Medio ambiente", []string{"ambiental", "contamina", "polvo", "relave", "derrame", "emision"}},
		{"Tierras y territorio", []string{"tierra", "terreno", "servidumbre", "posesion", "linder"}},
		{"Compromisos y beneficios", []string{"compromiso", "convenio", "beneficio", "aporte"}},
		{"Proveedores locales", []string{"proveedor", "compras locales"}},
		{"Salud", []string{"salud", "enfermedad", "posta"}},
		{"Movilización", []string{"paro", "bloqueo", "protesta", "marcha", "movilizacion", "huelga"}},
		{"Participación y consulta", []string{"consulta previa", "participacion", "asamblea", "audiencia"}},
		{"Gobernanza comunal", []string{"directiva", "eleccion", "junta", "representacion", "padron"}},
		{"Seguridad", []string{"violencia", "enfrentamiento", "agresion", "amenaza", "detenid"}},
		{"Canon y regalías", []string{"canon", "regalia"}},
	}
	out := make([]topicPattern, 0, len(keywords))
	for _, k := range keywords {
		quoted := make([]string, len(k.words))
		for i, w := range k.words {
			quoted[i] = regexp.QuoteMeta(w)
		}
		out = append(out, topicPattern{k.name, regexp.MustCompile(`(^|[^a-z0-9])(` + strings.Join(quoted, "|") + `)`)})
	}
	return out
}()

// text is text() of signals.ts: a string or number, trimmed; anything else is empty.
func text(v any) string {
	switch x := v.(type) {
	case string:
		return TrimJS(x)
	case json.Number, float64:
		return TrimJS(JSString(x))
	}
	return ""
}

// First is first(): the first non-empty field of keys.
func First(payload map[string]any, keys []string) string {
	for _, key := range keys {
		if v := text(payload[key]); v != "" {
			return v
		}
	}
	return ""
}

var (
	isoDay   = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})`)
	localDay = regexp.MustCompile(`^(\d{1,2})/(\d{1,2})/(\d{4})`)
)

func pad2(s string) string {
	if len(s) < 2 {
		return "0" + s
	}
	return s
}

// DayOf is dayOf(): YYYY-MM-DD from an ISO or dd/mm/yyyy date, "" when there is no valid one.
func DayOf(value string) string {
	var day string
	if m := isoDay.FindStringSubmatch(value); m != nil {
		day = m[1] + "-" + m[2] + "-" + m[3]
	} else if m := localDay.FindStringSubmatch(value); m != nil {
		day = m[3] + "-" + pad2(m[2]) + "-" + pad2(m[1])
	} else {
		return ""
	}
	if _, err := time.Parse(time.DateOnly, day); err != nil {
		return ""
	}
	return day
}

// DaysBetween is daysBetween(): whole days from one YYYY-MM-DD to another.
func DaysBetween(from, to string) int {
	a, _ := time.Parse(time.DateOnly, from)
	b, _ := time.Parse(time.DateOnly, to)
	return int(b.Sub(a).Hours() / 24)
}

// SeverityOf is severityOf(): 2 critical, 1.5 high, 1 otherwise.
func SeverityOf(value string) float64 {
	v := Fold(value)
	has := func(words ...string) bool {
		for _, w := range words {
			if strings.Contains(v, w) {
				return true
			}
		}
		return false
	}
	switch {
	case has("rojo", "critic", "muy alta"):
		return 2
	case has("naranja", "alta", "alto"):
		return 1.5
	}
	return 1
}

// capitalize is value.charAt(0).toUpperCase() + value.slice(1): only a first character of the
// Basic Multilingual Plane changes (charAt takes one UTF-16 code unit).
func capitalize(value string) string {
	r, size := utf8.DecodeRuneInString(value)
	if r == utf8.RuneError || utf16.IsSurrogate(r) || r > 0xffff {
		return value
	}
	return UpperJS(value[:size]) + value[size:]
}

func knownTopics(folded string) []string {
	var names []string
	for _, p := range topicPatterns {
		if p.pattern.MatchString(folded) {
			names = append(names, p.name)
		}
	}
	return names
}

// orderedSet keeps insertion order, as a JavaScript Set.
type orderedSet struct {
	seen  map[string]bool
	items []string
}

func (s *orderedSet) add(v string) {
	if s.seen == nil {
		s.seen = map[string]bool{}
	}
	if !s.seen[v] {
		s.seen[v] = true
		s.items = append(s.items, v)
	}
}

// topicsOf is topicsOf(): topic fields (mapped to a known topic when one matches), then keywords.
func topicsOf(payload map[string]any, spec moduleSpec) []string {
	var found orderedSet
	for _, key := range spec.topics {
		value := text(payload[key])
		if value == "" {
			continue
		}
		if matches := knownTopics(Fold(value)); len(matches) > 0 {
			for _, name := range matches {
				found.add(name)
			}
		} else {
			found.add(capitalize(value))
		}
	}
	parts := make([]string, len(spec.text))
	for i, key := range spec.text {
		parts[i] = text(payload[key])
	}
	for _, name := range knownTopics(Fold(strings.Join(parts, " "))) {
		found.add(name)
	}
	return found.items
}

// actorsOf is actorsOf(): names in actor fields, lists split on commas and semicolons.
func actorsOf(payload map[string]any, spec moduleSpec) []string {
	var names []string
	seen := map[string]bool{}
	for _, key := range spec.actors {
		for _, part := range strings.FieldsFunc(text(payload[key]), func(r rune) bool { return r == ';' || r == ',' }) {
			name := TrimJS(part)
			if Len16(name) > 1 && !seen[Fold(name)] {
				seen[Fold(name)] = true
				names = append(names, name)
			}
		}
	}
	return names
}

// SignalOutcome says why ToSignal gave no signal.
type SignalOutcome int

// Outcomes of ToSignal.
const (
	Dated SignalOutcome = iota
	Undated
	Ignored
)

// ToSignal is toSignal(): the record as a signal, Undated without a usable date, Ignored when it
// never counts (unknown module, alert generated by SIPGES, date after today).
func ToSignal(record SourceRecord, today string) (Signal, SignalOutcome) {
	spec, ok := moduleSpecs[record.Module]
	if !ok {
		return Signal{}, Ignored
	}
	p := record.Payload
	if record.Module == "Alertas" && text(p["Origen"]) == generatedOrigin {
		return Signal{}, Ignored
	}
	day := DayOf(First(p, spec.dates))
	if day == "" {
		return Signal{}, Undated
	}
	age := DaysBetween(day, today)
	if age < 0 {
		return Signal{}, Ignored
	}
	title := First(p, spec.titles)
	if title == "" {
		title = record.ID
	}
	s := Signal{
		Module:    record.Module,
		ID:        record.ID,
		Title:     Text16(title),
		Date:      day,
		AgeDays:   age,
		Severity:  SeverityOf(First(p, spec.severity)),
		Topics:    topicsOf(p, spec),
		Actors:    actorsOf(p, spec),
		Territory: First(p, TerritoryFields),
	}
	if Len16(title) > 120 {
		s.Title = Slice16(title, 117) + "…"
	}
	if record.Module == "Narrativas" {
		s.Tone = Fold(p["Tono"])
	}
	return s, Dated
}

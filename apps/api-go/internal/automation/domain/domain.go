// Package domain holds the pure parts of apps/api/src/contexts/automation that the read routes
// need: the event sources and vocabularies shown on the automation screen, record-module slugs
// for inbox links, the limit clamps of automation-service.ts and JavaScript's
// encodeURIComponent. rules.go and channels.go hold rule evaluation and channel validation.
//
//nolint:misspell // Spanish module names and labels, verbatim from the TypeScript API.
package domain

import (
	"fmt"
	"strings"
	"time"
)

// RecordModule is one entry of RECORD_MODULES (records/domain/modules.ts): URL slug and stored
// module name, in menu order.
type RecordModule struct {
	Slug   string
	Module string
}

// RecordModules is RECORD_MODULES, in the order of MODULES.
var RecordModules = []RecordModule{
	{"eventos", "Eventos"},
	{"actores", "Actores"},
	{"demandas", "Demandas"},
	{"compromisos", "Compromisos"},
	{"narrativas", "Narrativas"},
	{"fuentes", "Fuentes"},
	{"indicadores", "Indicadores"},
	{"alertas", "Alertas"},
	{"acciones", "Acciones"},
	{"directorio", "Directorio_Territorial"},
	{"priorizados", "Actores_Priorizados"},
	{"usuarios", "Usuarios"},
	{"roles", "Roles"},
	{"proyectos", "Proyectos"},
	{"intereses", "Intereses"},
	{"dialogos", "Dialogos"},
	{"oportunidades", "Oportunidades"},
	{"hechos", "Hechos_Compartidos"},
	{"aarc", "Evaluaciones_AARC"},
	{"buzon", "Buzon"},
	{"lecciones", "Lecciones_Territoriales"},
}

// Source is EventSource of automation-service.ts.
type Source struct {
	Module string `json:"module"`
	Label  string `json:"label"`
}

// systemSources is SYSTEM_EVENT_SOURCES of domain/rules.ts.
var systemSources = []Source{
	{"InteligenciaDigital", "Alertas de inteligencia digital"},
	{"PrevencionTerritorial", "Acciones de prevención"},
	{"Vinculos", "Vínculos entre registros"},
	{"Laboratorio_Documental", "Laboratorio documental"},
	{"IRSA", "Indicador IRSA"},
	{"Analista", "Propuestas del analista"},
}

// EventActions is EVENT_ACTIONS of domain/rules.ts.
var EventActions = []string{"CREATE", "UPDATE", "DELETE", "IMPORT", "UPLOAD", "CLASSIFY", "REVIEW", "SNAPSHOT", "CONFIG_UPDATE"}

// ConditionOps is CONDITION_OPS of domain/rules.ts.
var ConditionOps = []string{"eq", "neq", "contains", "gte", "lte", "present", "absent"}

// Sources is automation.sources(): every record module, labelled with its underscores as
// spaces, then the system sources.
func Sources() []Source {
	out := make([]Source, 0, len(RecordModules)+len(systemSources))
	for _, m := range RecordModules {
		out = append(out, Source{Module: m.Module, Label: strings.ReplaceAll(m.Module, "_", " ")})
	}
	return append(out, systemSources...)
}

// Slug is SLUGS.get(module) of automation-routes.ts: the URL slug of a stored record module.
func Slug(module string) (string, bool) {
	for _, m := range RecordModules {
		if m.Module == module {
			return m.Slug, true
		}
	}
	return "", false
}

// RunsLimit is the clamp of automation.runs: Math.min(Math.max(limit, 1), 200).
func RunsLimit(limit int64) int64 { return min(max(limit, 1), 200) }

// InboxLimit is the clamp of automation.inbox: Math.min(Math.max(limit, 1), 100).
func InboxLimit(limit int64) int64 { return min(max(limit, 1), 100) }

// EncodeURIComponent is JavaScript's encodeURIComponent for valid UTF-8 text: every byte
// outside A–Z a–z 0–9 - _ . ! ~ * ' ( ) as %XX in upper-case hex.
func EncodeURIComponent(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if unreserved(c) {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&15])
	}
	return b.String()
}

func unreserved(c byte) bool {
	switch {
	case 'A' <= c && c <= 'Z', 'a' <= c && c <= 'z', '0' <= c && c <= '9':
		return true
	}
	return strings.IndexByte("-_.!~*'()", c) >= 0
}

// ISOSeconds is isoSeconds of apps/api/src/platform/http/time.ts: Date.toISOString without the
// fractional seconds, including its six-digit signed years outside 0000-9999.
func ISOSeconds(t time.Time) string {
	t = t.UTC()
	year := fmt.Sprintf("%04d", t.Year())
	if t.Year() < 0 || t.Year() > 9999 {
		year = fmt.Sprintf("%+07d", t.Year())
	}
	return year + t.Format("-01-02T15:04:05") + "Z"
}

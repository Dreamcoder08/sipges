//nolint:misspell // Spanish module slugs and record fields, verbatim from the TypeScript API.
package domain

import "strings"

// modules is MODULES of modules.ts: URL slug → stored module name (app.py MODULES).
var modules = map[string]string{
	"eventos":       "Eventos",
	"actores":       "Actores",
	"demandas":      "Demandas",
	"compromisos":   "Compromisos",
	"narrativas":    "Narrativas",
	"fuentes":       "Fuentes",
	"indicadores":   "Indicadores",
	"alertas":       "Alertas",
	"acciones":      "Acciones",
	"directorio":    "Directorio_Territorial",
	"priorizados":   "Actores_Priorizados",
	"usuarios":      "Usuarios",
	"roles":         "Roles",
	"proyectos":     "Proyectos",
	"intereses":     "Intereses",
	"dialogos":      "Dialogos",
	"oportunidades": "Oportunidades",
	"hechos":        "Hechos_Compartidos",
	"aarc":          "Evaluaciones_AARC",
	"buzon":         "Buzon",
	"lecciones":     "Lecciones_Territoriales",
}

// MaxRecordID is MAX_RECORD_ID: the longest stored record id, in UTF-16 code units.
const MaxRecordID = 200

// ModuleForSlug is moduleForSlug: the stored module name of a URL slug.
func ModuleForSlug(slug string) (string, bool) {
	m, ok := modules[slug]
	return m, ok
}

// IsLookupableID is isLookupableId: a path id that can never be stored (NUL or over-long) is
// simply not found.
func IsLookupableID(id string) bool {
	return Len16(id) <= MaxRecordID && !strings.ContainsRune(id, 0)
}

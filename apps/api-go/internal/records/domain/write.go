//nolint:misspell // Spanish module names, fields and messages, verbatim from the TypeScript API.
package domain

import (
	"math"
	"strconv"
	"strings"
)

// The write rules of modules.ts and import.ts: the per-module id field, generated ids and their
// collision fallback, the tenant's project on every payload, and the spreadsheet import plan.

// idKeys is ID_KEYS: the payload field that carries the caller-chosen record id (app.py rid_for).
var idKeys = map[string]string{
	"Eventos":                 "ID_Evento",
	"Actores":                 "ID_Actor",
	"Demandas":                "ID_Demanda",
	"Compromisos":             "ID_Compromiso",
	"Narrativas":              "ID_Narrativa",
	"Fuentes":                 "ID_Fuente",
	"Indicadores":             "Codigo",
	"Alertas":                 "ID_Alerta",
	"Acciones":                "ID_Accion",
	"Usuarios":                "ID_Usuario",
	"Roles":                   "ID_Rol",
	"Proyectos":               "Proyecto_ID",
	"Buzon":                   "ID_Caso",
	"Lecciones_Territoriales": "ID_Leccion",
}

// prefixes is PREFIXES; other modules use their first three letters, upper-cased.
var prefixes = map[string]string{
	"Eventos":                 "EV",
	"Actores":                 "A",
	"Demandas":                "D",
	"Alertas":                 "AL",
	"Fuentes":                 "F",
	"Usuarios":                "USR",
	"Roles":                   "ROL",
	"Proyectos":               "PRJ",
	"Buzon":                   "BZ",
	"Lecciones_Territoriales": "LEC",
}

// RandomHex returns length random hexadecimal digits (upper case in the API, see compose.ts).
type RandomHex func(length int) string

// Problem is a refused field: InvalidPayload of records-service.ts without its kind.
type Problem struct {
	Field   string
	Message string
}

// ValidatePayload is validatePayload: the id field, when present and not empty, must be a string
// or finite number of at most MaxRecordID characters.
func ValidatePayload(module string, payload *Object) *Problem {
	key, ok := idKeys[module]
	if !ok {
		return nil
	}
	value, present := payload.Get(key)
	if !present || value == nil || value == "" {
		return nil
	}
	length := -1
	switch v := value.(type) {
	case string:
		length = Units16(v)
	case float64:
		if !math.IsInf(v, 0) && !math.IsNaN(v) {
			length = len(NumberString(v))
		}
	}
	if length >= 0 && length <= MaxRecordID {
		return nil
	}
	return &Problem{Field: key, Message: key + " must be a string or number of at most " + strconv.Itoa(MaxRecordID) + " characters"}
}

// RecordIDFor is recordIdFor: the id field unless it is missing, null, the empty string or 0,
// otherwise `<prefix>-<8 hex>`.
func RecordIDFor(module string, payload *Object, randomHex RandomHex) string {
	if key, ok := idKeys[module]; ok {
		value, present := payload.Get(key)
		if present && value != nil && value != "" && value != 0.0 {
			if f, isNumber := value.(float64); isNumber {
				return NumberString(f)
			}
			if s, isString := value.(string); isString {
				return s
			}
			// ValidatePayload refuses every other type before an id is chosen.
		}
	}
	prefix, ok := prefixes[module]
	if !ok {
		prefix = strings.ToUpper(module[:3])
	}
	return prefix + "-" + randomHex(8)
}

// CollisionID is collisionId: `<id>-<4 hex>`.
func CollisionID(id string, randomHex RandomHex) string { return id + "-" + randomHex(4) }

// WithAssignedID is withAssignedId: projects carry their own id inside the payload.
func WithAssignedID(module string, payload *Object, id string) *Object {
	if module != "Proyectos" {
		return payload
	}
	out := payload.Clone()
	out.Set("Proyecto_ID", id)
	return out
}

// WithTenantProject is withTenantProject: a missing or empty Proyecto_ID takes the tenant's
// project, another project's id is refused; Proyectos keeps Proyecto_ID as its record id.
func WithTenantProject(module string, payload *Object, projectID string) (*Object, *Problem) {
	if module == "Proyectos" {
		return payload, nil
	}
	value, present := payload.Get("Proyecto_ID")
	if !present || value == nil || value == "" || value == projectID {
		out := payload.Clone()
		out.Set("Proyecto_ID", projectID)
		return out, nil
	}
	return nil, &Problem{Field: "Proyecto_ID", Message: "Proyecto_ID no corresponde al proyecto activo"}
}

// TenantProject is tenantProject of records-service.ts: the project of a `company/project`
// tenant id (split at the first slash), or "" for ids without one.
func TenantProject(tenantID string) string {
	_, project, _ := strings.Cut(tenantID, "/")
	return project
}

// MaxImportRows is MAX_IMPORT_ROWS.
const MaxImportRows = 2000

// MaxImportValue is MAX_IMPORT_VALUE, in UTF-16 code units.
const MaxImportValue = 10_000

// IsImportable is isImportable: administration modules are never bulk-imported.
func IsImportable(module string) bool {
	return module != "Usuarios" && module != "Roles" && module != "Proyectos"
}

// ImportProblem is one refused spreadsheet row, numbered from 1.
type ImportProblem struct {
	Row     int
	Message string
}

// ImportItem is one record to merge.
type ImportItem struct {
	Row     int
	ID      string
	Payload *Object
}

// PlanImport is planImport: values are trimmed, blank cells skipped, each row gets the module's id
// rule; with a projectID, rows take the tenant's project and a row naming another one is refused.
// Rows hold only string values (ImportInput checked them).
func PlanImport(module string, rows []*Object, randomHex RandomHex, projectID string) ([]ImportItem, []ImportProblem) {
	items := []ImportItem{}
	problems := []ImportProblem{}
	seen := map[string]int{}
	for index, raw := range rows {
		row := index + 1
		payload := NewObject()
		for _, field := range raw.Keys() {
			value, _ := raw.Get(field)
			text := trimJS(value.(string))
			name := trimJS(field)
			// `payload["__proto__"] = text` sets no property: a string is no prototype.
			if name == "" || text == "" || name == "__proto__" {
				continue
			}
			payload.Set(name, text)
		}
		keys := payload.Keys()
		if len(keys) == 0 {
			continue
		}
		if hasNULText(payload) {
			problems = append(problems, ImportProblem{row, "Contiene caracteres NUL"})
			continue
		}
		if longValue(payload) {
			problems = append(problems, ImportProblem{row, "Un valor supera " + strconv.Itoa(MaxImportValue) + " caracteres"})
			continue
		}
		if invalid := ValidatePayload(module, payload); invalid != nil {
			problems = append(problems, ImportProblem{row, invalid.Field + ": " + invalid.Message})
			continue
		}
		owned := payload
		if projectID != "" {
			var refused *Problem
			owned, refused = WithTenantProject(module, payload, projectID)
			if refused != nil {
				problems = append(problems, ImportProblem{row, refused.Field + ": " + refused.Message})
				continue
			}
		}
		id := RecordIDFor(module, payload, randomHex)
		if previous, ok := seen[id]; ok {
			problems = append(problems, ImportProblem{row, "El código " + id + " ya aparece en la fila " + strconv.Itoa(previous)})
			continue
		}
		seen[id] = row
		items = append(items, ImportItem{Row: row, ID: id, Payload: owned})
	}
	return items, problems
}

func hasNULText(payload *Object) bool {
	for _, k := range payload.Keys() {
		v, _ := payload.Get(k)
		if strings.ContainsRune(k, 0) || strings.ContainsRune(v.(string), 0) {
			return true
		}
	}
	return false
}

func longValue(payload *Object) bool {
	for _, k := range payload.Keys() {
		v, _ := payload.Get(k)
		if Units16(v.(string)) > MaxImportValue {
			return true
		}
	}
	return false
}

// TrimJS is String.prototype.trim.
func TrimJS(s string) string { return trimJS(s) }

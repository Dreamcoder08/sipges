package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"

	js "github.com/Dreamcoder08/sipges/apps/api-go/internal/situations/domain"
)

// The record side of an upload (attachment.ts): which project an attachment shows and the
// fields app.py writes back into the linked record. The payload is read as JSON.parse reads the
// jsonb the driver returns, so numbers are JavaScript numbers.

// legacyProject is LEGACY_PROJECT: the migrated installation's default project and its name.
const (
	legacyProjectID   = "PRJ-SECHURA"
	legacyProjectName = "Proyecto Sechura"
)

// Payload is a record payload as JSON.parse returns it: objects as maps, numbers as
// json.Number (read as float64 where JavaScript would).
type Payload map[string]any

// ParsePayload decodes a jsonb object payload.
func ParsePayload(raw []byte) (Payload, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var p Payload
	if err := dec.Decode(&p); err != nil {
		return nil, err
	}
	if p == nil {
		return nil, fmt.Errorf("record payload is not an object")
	}
	return p, nil
}

// ProjectOf is projectOf: the linked record's own Proyecto_ID/Proyecto (JavaScript truthiness
// and String()), else the active scope's project, never a hard-coded default (docs/adr/0008 #6).
func ProjectOf(p Payload, scopeProjectID string) (projectID, projectName string) {
	projectID = scopeProjectID
	if v := p["Proyecto_ID"]; truthy(v) {
		projectID = js.JSString(v)
	}
	if v := p["Proyecto"]; truthy(v) {
		projectName = js.JSString(v)
	}
	if projectName == "" && projectID == legacyProjectID {
		projectName = legacyProjectName
	}
	return projectID, projectName
}

// truthy is JavaScript's ToBoolean for a decoded JSON value.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case json.Number:
		f := js.Float(x)
		return f != 0 && !math.IsNaN(f)
	}
	return true // objects and arrays, even empty
}

// Link is what an upload appends to the record's Adjuntos list. DocumentType and Verification
// are the JavaScript strings the TypeScript store writes: a slice may leave them ending in a
// lone surrogate, which JSON.stringify writes as "\ud83d" and PostgreSQL's jsonb refuses.
type Link struct {
	ID, FileName               string
	DocumentType, Verification js.Text16
}

// LinkIntoPayload is linkIntoPayload followed by JSON.stringify: the payload with the link
// appended to Adjuntos (a new list when Adjuntos is not an array), plus `Evidencia/Resultado`
// for eventos and `Archivo_Fuente` for fuentes.
func LinkIntoPayload(p Payload, moduleSlug string, link Link) ([]byte, error) {
	next := make(map[string]any, len(p)+2)
	for k, v := range p {
		next[k] = v
	}
	current, _ := p["Adjuntos"].([]any)
	adjuntos := make([]any, 0, len(current)+1)
	adjuntos = append(adjuntos, current...)
	next["Adjuntos"] = append(adjuntos, map[string]any{
		"id":           link.ID,
		"archivo":      link.FileName,
		"tipo":         link.DocumentType,
		"verificacion": link.Verification, //nolint:misspell // Spanish field of app.py
	})
	switch moduleSlug {
	case "eventos":
		next["Evidencia/Resultado"] = link.FileName
	case "fuentes":
		next["Archivo_Fuente"] = link.FileName
	}
	return json.Marshal(stringifyNumbers(next))
}

// stringifyNumbers rewrites every number as JSON.stringify writes the double JSON.parse read:
// shortest round trip ("1e+21", "0" for -0), and null for a value too large for a double.
func stringifyNumbers(v any) any {
	switch x := v.(type) {
	case json.Number:
		f := js.Float(x)
		if math.IsInf(f, 0) || math.IsNaN(f) {
			return nil
		}
		return json.RawMessage(js.JSNumber(f))
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, item := range x {
			out[k] = stringifyNumbers(item)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, item := range x {
			out[i] = stringifyNumbers(item)
		}
		return out
	}
	return v
}

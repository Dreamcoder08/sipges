// Package domain holds the analytics record shapes and module lists of
// apps/api/src/contexts/analytics/domain/records.ts, the JavaScript value semantics the
// dashboard counters rely on (python.ts) and the dashboard counters themselves (dashboard.ts).
// The engines (situational, strategic, consensus, integrated) are not here: they run in the
// Rust analytics module (engines/, ADR 0032).
package domain

import (
	"bytes"
	"encoding/json"
)

// SituationalModules are the modules buildSituational reads (SITUATIONAL_MODULES plus
// 'Proyectos', which names the project), in analytics-service.ts order.
var SituationalModules = []string{
	"Eventos", "Actores", "Demandas", "Compromisos", "Narrativas", "Alertas", "Acciones", "Fuentes", "Proyectos", //nolint:misspell // Spanish name kept verbatim from the TypeScript API
}

// ExtendedModules are EXTENDED_MODULES (app.py RC 1.7 second layer) in key order: the input of
// the strategic, consensus and integrated engines.
var ExtendedModules = []string{"Intereses", "Dialogos", "Oportunidades", "Hechos_Compartidos", "Evaluaciones_AARC"}

// DashboardModules are DASHBOARD_MODULES of dashboard.ts.
var DashboardModules = []string{
	"Eventos", "Actores", "Demandas", "Alertas", "Directorio_Territorial", "Actores_Priorizados", //nolint:misspell // Spanish name kept verbatim from the TypeScript API
}

// StoredRecord is a module record as persisted: its id and its JSON object payload, as
// PostgreSQL returns it.
type StoredRecord struct {
	ID      string
	Payload json.RawMessage
}

// ModuleRecords are one module's records, newest first.
type ModuleRecords struct {
	Module  string
	Records []StoredRecord
}

// RecordsByModule is RecordsByModule of records.ts: one entry per requested module, in the
// requested order, each newest first (app.py `ORDER BY updated_at DESC`).
type RecordsByModule []ModuleRecords

// EmptyRecords returns an empty list for each module, as the TypeScript readers start from.
func EmptyRecords(modules []string) RecordsByModule {
	out := make(RecordsByModule, len(modules))
	for i, m := range modules {
		out[i] = ModuleRecords{Module: m, Records: []StoredRecord{}}
	}
	return out
}

// Add appends a record to its module; a module that was not requested is ignored, like
// `result[row.module]?.push` in the readers.
func (r RecordsByModule) Add(module string, record StoredRecord) {
	for i := range r {
		if r[i].Module == module {
			r[i].Records = append(r[i].Records, record)
			return
		}
	}
}

// Of returns a module's records, or none when it was not requested.
func (r RecordsByModule) Of(module string) []StoredRecord {
	for _, m := range r {
		if m.Module == module {
			return m.Records
		}
	}
	return nil
}

// MarshalJSON writes the engines' `records` field: {module: [{id, payload}]} in module order,
// each payload verbatim.
func (r RecordsByModule) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, m := range r {
		if i > 0 {
			b.WriteByte(',')
		}
		if err := writeJSONString(&b, m.Module); err != nil {
			return nil, err
		}
		b.WriteString(":[")
		for j, rec := range m.Records {
			if j > 0 {
				b.WriteByte(',')
			}
			b.WriteString(`{"id":`)
			if err := writeJSONString(&b, rec.ID); err != nil {
				return nil, err
			}
			b.WriteString(`,"payload":`)
			payload := rec.Payload
			if len(payload) == 0 {
				payload = json.RawMessage("{}")
			}
			b.Write(payload)
			b.WriteByte('}')
		}
		b.WriteByte(']')
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func writeJSONString(b *bytes.Buffer, s string) error {
	out, err := json.Marshal(s)
	if err != nil {
		return err
	}
	b.Write(out)
	return nil
}

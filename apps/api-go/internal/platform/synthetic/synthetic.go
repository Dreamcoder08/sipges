// Package synthetic generates deterministic module records for benchmarks, in the shape of
// apps/api/bench/synthetic.ts: legacy field names, values from a fixed vocabulary, never real data.
// Payloads are written as PostgreSQL writes jsonb::text (keys by length then bytes, ", " and
// ": " separators), the text the API reads from module_records.
//
//nolint:misspell // Spanish field names and words, as apps/api/bench/synthetic.ts writes them.
package synthetic

import (
	"cmp"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"slices"
	"strings"
)

// BaseCounts are the records per module at scale 1 (bench/synthetic.ts BASE_COUNTS).
var BaseCounts = map[string]int{
	"Eventos": 25, "Actores": 22, "Demandas": 12, "Compromisos": 2, "Narrativas": 7, "Fuentes": 8,
	"Alertas": 9, "Acciones": 9, "Directorio_Territorial": 159, "Actores_Priorizados": 131,
	"Intereses": 20, "Dialogos": 20, "Oportunidades": 20, "Hechos_Compartidos": 20, "Evaluaciones_AARC": 20,
}

// Record is one module_records row.
type Record struct {
	Module  string
	ID      string
	Payload string // jsonb::text
}

var (
	vocabulary = strings.Fields(`agua empleo asamblea directiva dirigentes tierras servidumbre concesion
contaminacion polvo pesca maricultura proveedores capacitacion compromiso acuerdo dialogo mesa reunion
paro bloqueo movilizacion denuncia rechazo municipalidad subprefectura oficio cronograma trazabilidad
legitimidad representacion padron eleccion facebook prensa publicaciones narrativa influencia liderazgo
alianza riesgo emergencia seguridad accidente vias salud educacion caminos canal riego ganado pozo bahia
transporte vivienda energia`)
	states     = []string{"Abierta", "En seguimiento", "Cerrada", "Pendiente", "Validado", "Descartada"}
	levels     = []string{"Alta", "Media", "Baja", "Crítica", "Rojo", "Amarillo"}
	dimensions = []string{"G", "A", "D", "N", "E", "I"}
)

// Records returns BaseCounts×scale records per module, the same ones for the same scale.
func Records(scale int) map[string][]Record {
	r := rand.New(rand.NewPCG(42, uint64(scale))) //nolint:gosec // deterministic benchmark data
	pick := func(xs []string) string { return xs[r.IntN(len(xs))] }
	sentence := func(n int) string {
		words := make([]string, n)
		for i := range words {
			words[i] = pick(vocabulary)
		}
		return strings.Join(words, " ")
	}
	date := func() string { return fmt.Sprintf("2026-%02d-15", 1+r.IntN(9)) }
	out := map[string][]Record{}
	for _, module := range slices.Sorted(func(yield func(string) bool) {
		for m := range BaseCounts {
			if !yield(m) {
				return
			}
		}
	}) {
		for i := range BaseCounts[module] * scale {
			id := fmt.Sprintf("%s-%d", strings.ToUpper(module[:3]), i)
			p := map[string]any{
				"Proyecto_ID": "PRJ-SECHURA", "Territorio": fmt.Sprintf("Sector %d", 1+i%12),
				"Fuente_ID": fmt.Sprintf("FUE-%d", i%40), "Observaciones": sentence(12),
			}
			switch module {
			case "Eventos":
				p["ID_Evento"], p["Fecha"], p["Tipo_Evento"] = id, date(), pick([]string{"Reunión", "Protesta", "Denuncia", "Acuerdo"})
				p["Descripcion_Hecho"], p["Dimension_Principal"], p["Relevancia_Preliminar"] = sentence(30), pick(dimensions), pick(levels)
				p["Nivel_Verificacion"], p["Estado_Validacion"], p["Actor_Principal"] = pick([]string{"A", "B", "C", "D", "E"}), pick(states), fmt.Sprintf("ACT-%d", i%50)
			case "Actores":
				p["ID_Actor"], p["Nombre_Actor/Organizacion"], p["Tipo_Actor"] = id, fmt.Sprintf("Organización sintética %d", i), pick([]string{"Comunal", "Estatal", "Empresa", "Gremio"})
				p["Influencia"], p["Interes"], p["Posicion_Proyecto"] = pick(levels[:3]), sentence(8), pick([]string{"A favor", "Neutral", "En contra"})
			case "Compromisos":
				p["ID_Compromiso"], p["Descripcion"], p["Estado"], p["Plazo"], p["Avance_%"] = id, sentence(20), pick([]string{"Abierto", "Vencido", "Cumplido"}), date(), r.IntN(100)
			case "Alertas":
				p["ID_Alerta"], p["Estado"], p["Nivel_Preliminar"], p["Dimension"], p["Causa"], p["Fecha"] = id, pick(states), pick(levels), pick(dimensions), sentence(15), date()
			case "Acciones":
				p["ID_Accion"], p["ID_Alerta"], p["Accion"], p["Estado"], p["Plazo"] = id, fmt.Sprintf("ALE-%d", i%30), sentence(12), pick(states), date()
			case "Directorio_Territorial", "Actores_Priorizados":
				p["Cargo"], p["Institución / Organización"] = pick([]string{"Presidente", "Secretaria", "Teniente", "Regidor"}), fmt.Sprintf("Institución sintética %d", i%80)
				p["Nombre actualizado 2026"], p["Prioridad"], p["Estado de verificación"] = fmt.Sprintf("Persona sintética %d", i), pick(levels), pick(states)
			case "Evaluaciones_AARC":
				p["Dimension"], p["Puntaje"], p["Evidencia"] = pick([]string{"Acceso", "Aceptabilidad", "Respeto"}), 1+r.IntN(5), sentence(10)
			default: // Demandas, Narrativas, Fuentes and the RC 1.7 modules
				p["ID"], p["Tema"], p["Descripcion"], p["Estado"], p["Prioridad"], p["Fecha_Registro"] = id, sentence(3), sentence(25), pick(states), pick(levels), date()
			}
			out[module] = append(out[module], Record{Module: module, ID: id, Payload: JSONBText(p)})
		}
	}
	return out
}

// JSONBText writes a flat object as jsonb::text does: keys by length, then bytes.
func JSONBText(p map[string]any) string {
	keys := slices.SortedFunc(func(yield func(string) bool) {
		for k := range p {
			if !yield(k) {
				return
			}
		}
	}, func(a, b string) int { return cmp.Or(cmp.Compare(len(a), len(b)), strings.Compare(a, b)) })
	var b strings.Builder
	b.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			b.WriteString(", ")
		}
		key, _ := json.Marshal(k)
		value, _ := json.Marshal(p[k])
		b.Write(key)
		b.WriteString(": ")
		b.Write(value)
	}
	b.WriteByte('}')
	return b.String()
}

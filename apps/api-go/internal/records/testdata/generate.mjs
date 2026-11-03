// Records the TypeScript records domain's answers on synthetic payloads, for the Go port's
// pinned test (../domain/fixtures_test.go). Run from the repository root after changing either side:
//
//   node apps/api-go/internal/records/testdata/generate.mjs          # rewrites the fixture
//   node apps/api-go/internal/records/testdata/generate.mjs --check  # exit 1 when it drifted
//
// Every payload is synthetic: no real record is read.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { diffPayloads } from '../../../../api/src/contexts/records/domain/history.ts';
import { SUMMARY_TYPES, summarizeRecord } from '../../../../api/src/contexts/records/domain/summary.ts';

const OUT = fileURLToPath(new URL('./fixtures.json', import.meta.url));

// JSON texts as PostgreSQL could hand them out (jsonb text), parsed by JSON.parse on the
// TypeScript side exactly as postgres.js does.
const PAYLOADS = [
  '{}',
  '{"Fecha": "2026-01-02", "Territorio": " Sechura ", "Estado_Validacion": "Validado", "Descripcion_Hecho": "Bloqueo de vía", "Nivel_Verificacion": "B - Corroborada"}',
  '{"Fecha": 20260102, "Territorio": null, "Descripcion_Hecho": "", "Nivel_Verificacion": "Por verificar"}',
  '{"2": "dos", "10": "diez", "b": 1, "a": 2, "01": "cero uno", "_id": "propio", "4294967295": "no índice", "4294967294": "índice"}',
  '{"Nombre": "", "Territorio": "", "Lugar / ámbito": "  Bayóvar  ", "Nombre actualizado 2026": "Junta vecinal"}',
  '{"Nombre": null, "Ciudad": "Piura", "Distrito": "Vice"}',
  '{"Nombre actualizado 2026": {"z": 1, "a": [1, 2.5, 1e21, 1e-7, -0, true, null, "x"]}, "Localidad": [" a ", {"10": 1, "9": 2}]}',
  '{"Descripcion": 1.0, "Fecha_Registro": 123456789012345678901234567890, "Territorio": 1e400}',
  '{"Asunto": "\\"comillas\\" \\\\ barra \\n línea \\t tab \\u0001 \\u001f \\u007f \\u2028 <b>&amp;</b> 😀", "Fecha": false, "Territorio": true}',
  '{"Archivo_Fuente": "acta.pdf", "Fecha_Documento": "2025-12-31", "Nivel_Base_Verificacion": "A - Confirmada"}',
  '{"Archivo_Fuente": "  ", "Nivel_Base_Verificacion": "F - Otra", "Nivel_Verificacion": "C -"}',
  '{"Descripcion": "Narrativa", "Fecha_Inicio": "2026-02-01", "Nivel_Verificacion": "E - Falsa", "Territorio": "ignorado"}',
  '{"Nombre_Actor/Organizacion": "\\u00a0\\ufeff Comunidad \\u3000", "Territorio": "La Unión"}',
  '{"__proto__": {"a": 1}, "constructor": "c", "toString": 2, "Asunto": "proto"}',
  '{"__proto__": {}, "valueOf": null, "Asunto": "proto vacío"}',
  '{"x": 0.1, "y": 5e-324, "z": 1.7976931348623157e308, "w": 1e-400, "v": 100000000000000000000, "u": 123e-20}',
  '{"x": 0.10, "y": 5e-324, "z": 1.7976931348623157e308, "w": 0, "v": 1e20, "u": 1.23e-18, "t": 2e400}',
  '{"x": [1, {"b": 2, "a": 1}], "y": "Ä", "z": {}}',
  '{"x": [1, {"a": 1, "b": 2}], "y": "Z", "ä": 1, "Z": 2, "😀": 3, "\\uffff": 4}',
];

const parse = (text) => JSON.parse(text);

const cases = PAYLOADS.map((text) => ({
  payload: text,
  list: JSON.stringify({ ...parse(text), _id: 'REC-1', _updated_at: '2026-01-02T03:04:05Z' }),
  get: JSON.stringify({ ...parse(text), _id: 'REC-1' }),
  summaries: SUMMARY_TYPES.map((type) => JSON.stringify(summarizeRecord(type, 'REC-1', parse(text)))),
}));

const diffs = [];
for (let i = 0; i < PAYLOADS.length; i++) {
  for (const j of [i + 1, i + 2, -1]) {
    const before = i === 0 && j === -1 ? null : PAYLOADS[i];
    const after = j === -1 ? null : PAYLOADS[j % PAYLOADS.length];
    diffs.push({
      before,
      after,
      changes: JSON.stringify(
        diffPayloads(before === null ? null : parse(before), after === null ? null : parse(after)),
      ),
    });
  }
}
diffs.push({ before: null, after: PAYLOADS[13], changes: JSON.stringify(diffPayloads(null, parse(PAYLOADS[13]))) });
diffs.push({ before: PAYLOADS[13], after: PAYLOADS[13], changes: JSON.stringify(diffPayloads(parse(PAYLOADS[13]), parse(PAYLOADS[13]))) });

const text = `${JSON.stringify({ slugs: SUMMARY_TYPES.map((t) => t.slug), cases, diffs }, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('fixtures.json drifted: rerun without --check');
    process.exit(1);
  }
} else writeFileSync(OUT, text);

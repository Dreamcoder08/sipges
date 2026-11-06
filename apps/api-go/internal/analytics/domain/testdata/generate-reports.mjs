// Records the TypeScript report outlines on synthetic records:
// node --experimental-strip-types generate-reports.mjs > reports.json
import { automatedConsensus } from '../../../../../api/src/contexts/analytics/domain/consensus.ts';
import { integratedAnalysis } from '../../../../../api/src/contexts/analytics/domain/integrated.ts';
import { extendedRecords } from '../../../../../api/src/contexts/analytics/domain/records.ts';
import {
  consensusReport,
  integratedReport,
  situationalReport,
  strategicReport,
} from '../../../../../api/src/contexts/analytics/domain/reports.ts';
import { buildSituational } from '../../../../../api/src/contexts/analytics/domain/situational.ts';
import { strategicAssessment } from '../../../../../api/src/contexts/analytics/domain/strategic.ts';

const at = '2026-10-06T10:00:00Z';
const record = (id, payload) => ({ id, payload });
const many = (prefix, count, payload) =>
  Array.from({ length: count }, (_, i) => record(`${prefix}-${i}`, { ...payload, Nota: i }));

const full = {
  Eventos: [
    record('EV-1', { Territorio: 'Sechura', Descripcion: 'Bloqueo <vía> & "paso"' }),
    record('EV-2', { Territorio: 'Sechura', Estado: 'Abierto' }),
    record('EV-3', { Territorio: 12 }),
  ],
  Actores: [record('A-1', { Nombre_Actor: 'Comité' })],
  Demandas: [
    record('D-1', { Tema: 'Agua', Descripcion: 'Línea 1\nLínea 2', Estado: 'Abierta', Fuente_ID: 'F-1' }),
    record('D-2', { Tema: 7, Descripcion: null, Estado: 'Pendiente', Fuente_ID: '' }),
    record('D-3', { Estado: 'Cerrada', Tema: 'Oculta' }),
    record('D-4', { Tema: { a: 1, b: [2, 'x'] }, Estado: 'Abierta', Fuente_ID: 0 }),
  ],
  Compromisos: [record('C-1', { Estado: 'Vencido', Compromiso: 'Entrega' })],
  Narrativas: [],
  Alertas: [
    record('AL-1', { Nivel_Preliminar: 'Rojo', Causa: 'Cruce', Estado: 'Activa', Fuente_ID: 'F-2' }),
    record('AL-2', { Causa: null, Estado: 'Activa' }),
    record('AL-3', { Nivel_Preliminar: null, Estado: 'Activa', Causa: true, Fuente_ID: ['F-3'] }),
  ],
  Acciones: [],
  Fuentes: [record('F-1', { Nombre: 'Acta' })],
  Proyectos: [record('PRJ-1', { Nombre: 'Proyecto Sintético', Proyecto_ID: 'PRJ-1' })],
  Intereses: [
    record('I-1', { Actor: 'Comité', Posicion: 'A favor', Interes: 'Agua potable para Sechura', Preocupacion: 0, Fuente_ID: 'F-1' }),
    record('I-2', { Actor: null, Interes: '', Posicion: false }),
  ],
  Dialogos: [
    record('DI-1', { Proceso: 'Mesa', Participantes: ['Comité', 'Empresa'], Tema: 'Agua potable para Sechura', Estado: 'En curso', Proximo_Paso: 'Acta' }),
    ...many('DI-X', 42, { Proceso: 'Mesa', Estado: 'Cerrado' }),
  ],
  Oportunidades: [record('O-1', { Oportunidad: 'Riego', Beneficiarios: 100.5, Viabilidad: 'Alta', Estado: 'Abierta', Responsable: 'Equipo' })],
  Hechos_Compartidos: [record('H-1', { Asunto: 'Agua potable para Sechura', Estado: 'En revisión', Versiones: 'Dos', Fuente_ID: 'F-1', Accion_Verificacion: 'Visita' })],
  Evaluaciones_AARC: [record('AA-1', { Actor_Proceso: 'Mesa', Reconocimiento: 'Bajo', Agencia: 'Baja', Reciprocidad: 'Baja', Claridad: 'Baja', Evidencia: 'Acta' })],
};

const inputs = { full, empty: {} };
const out = {};
for (const [name, records] of Object.entries(inputs)) {
  const extended = extendedRecords(records);
  const situational = buildSituational(records, 'PRJ-1', at, name === 'full' ? null : 'Etiqueta');
  const strategic = strategicAssessment(extended, 'PRJ-1', at);
  const integrated = integratedAnalysis(extended, 'PRJ-1', at);
  const consensus = automatedConsensus(extended, 'PRJ-1', at);
  out[name] = {
    records,
    situational,
    strategic,
    integrated,
    consensus,
    reports: {
      situational: situationalReport(situational).blocks,
      strategic: strategicReport(extended, strategic, situational).blocks,
      integrated: integratedReport(integrated).blocks,
      consensus: consensusReport(consensus).blocks,
    },
  };
}
process.stdout.write(`${JSON.stringify(out)}\n`);

import type { RecordNeighbourhood } from '@mascli/contracts';
import { describe, expect, it } from 'vitest';
import { buildDossier } from './operations.ts';

type Node = RecordNeighbourhood['nodes'][number];
type Edge = RecordNeighbourhood['edges'][number];

const node = (
  module: string,
  id: string,
  title: string,
  fields: Record<string, string> = {},
  date: string | null = null,
): Node => ({
  module,
  id,
  type_label: module,
  title,
  date,
  marking: 'interno',
  fields,
});

const edge = (
  link_type: string,
  source: [string, string],
  target: [string, string],
  inferred = false,
): Edge => ({
  id: inferred ? null : 1,
  link_type,
  source: { module: source[0], id: source[1] },
  target: { module: target[0], id: target[1] },
  inferred,
  via: null,
  note: '',
  created_by: null,
  created_at: null,
  evidence: null,
  evidence_status: 'undocumented',
});

const graph = (nodes: Node[], edges: Edge[], truncated = false): RecordNeighbourhood => ({
  seeds: [],
  nodes,
  edges,
  truncated,
});

const TODAY = '2026-10-19';

describe('territorial operations dossier', () => {
  const observed = node(
    'eventos',
    'EV-1',
    'Bloqueo de vía',
    { Nivel_Verificacion: 'B - Probable', Fuente_ID: 'F-1' },
    '2026-09-02',
  );
  const estimated = node('eventos', 'EV-2', 'Rumor de paro', {}, '2026-09-10');
  const demand = node('demandas', 'D-1', 'Agua potable', { Estado: 'Nueva' }, '2026-08-01');
  const alert = node('alertas', 'AL-1', 'Riesgo de paralización', {
    Estado: 'Abierta',
    Nivel_Preliminar: 'Naranja',
    Accion_Sugerida: 'Convocar mesa técnica',
  });
  const rumourAlert = node('alertas', 'AL-2', 'Paro anunciado', {
    Estado: 'Abierta',
    Nivel_Preliminar: 'Amarillo',
  });

  it('chains signals to the alerts they justify and the actions that attend them', () => {
    const action = node('acciones', 'AC-1', 'Mesa de diálogo', {
      Estado: 'Cumplida',
      Resultado: 'Acta con tres acuerdos',
    });
    const dossier = buildDossier(
      graph(
        [observed, alert, action],
        [
          edge('origina', ['eventos', 'EV-1'], ['alertas', 'AL-1']),
          edge('atiende', ['acciones', 'AC-1'], ['alertas', 'AL-1'], true),
        ],
      ),
      [{ module: 'eventos', id: 'EV-1' }],
      TODAY,
    );
    expect(dossier.signals.map((s) => [s.id, s.evidence])).toEqual([['EV-1', 'observado']]);
    expect(dossier.alerts).toHaveLength(1);
    expect(dossier.alerts[0]).toMatchObject({
      id: 'AL-1',
      level: 'Naranja',
      open: true,
      suggested: 'Convocar mesa técnica',
    });
    expect(dossier.alerts[0]?.basis.map((s) => s.id)).toEqual(['EV-1']);
    expect(dossier.alerts[0]?.actions.map((a) => [a.id, a.result])).toEqual([
      ['AC-1', 'Acta con tres acuerdos'],
    ]);
    expect(dossier.attention).toEqual([]);
  });

  it('flags open alerts without action and alerts supported only by estimated signals', () => {
    const dossier = buildDossier(
      graph([estimated, rumourAlert], [edge('origina', ['eventos', 'EV-2'], ['alertas', 'AL-2'])]),
      [{ module: 'eventos', id: 'EV-2' }],
      TODAY,
    );
    expect(dossier.attention.map((a) => [a.kind, a.ref.id])).toEqual([
      ['alerta_sin_accion', 'AL-2'],
      ['alerta_sin_sustento', 'AL-2'],
    ]);
  });

  it('never counts a cancelled action as attending an alert and closed alerts as pending', () => {
    const cancelled = node('acciones', 'AC-2', 'Visita suspendida', { Estado: 'Cancelada' });
    const closed = node('alertas', 'AL-3', 'Resuelta', { Estado: 'Cerrada' });
    const dossier = buildDossier(
      graph(
        [observed, alert, closed, cancelled],
        [
          edge('origina', ['eventos', 'EV-1'], ['alertas', 'AL-1']),
          edge('origina', ['eventos', 'EV-1'], ['alertas', 'AL-3']),
          edge('atiende', ['acciones', 'AC-2'], ['alertas', 'AL-1']),
        ],
      ),
      [{ module: 'eventos', id: 'EV-1' }],
      TODAY,
    );
    expect(dossier.attention.map((a) => [a.kind, a.ref.id])).toEqual([
      ['alerta_sin_accion', 'AL-1'],
    ]);
  });

  it('marks overdue actions and commitments from explicit dates only', () => {
    const late = node('acciones', 'AC-3', 'Entrega de cisternas', {
      Estado: 'En proceso',
      Fecha_Vencimiento: '2026-10-01',
    });
    const vague = node('acciones', 'AC-4', 'Seguimiento', { Estado: 'Pendiente', Plazo: 'Pronto' });
    const done = node('acciones', 'AC-5', 'Taller', { Estado: 'Cumplida' });
    const commitment = node('compromisos', 'C-1', 'Cisterna semanal', {
      Estado: 'En proceso',
      'Avance_%': '40',
      Fecha_Vencimiento: '2026-09-30',
    });
    const dossier = buildDossier(
      graph(
        [observed, alert, demand, late, vague, done, commitment],
        [
          edge('origina', ['eventos', 'EV-1'], ['alertas', 'AL-1']),
          edge('atiende', ['acciones', 'AC-3'], ['alertas', 'AL-1']),
          edge('atiende', ['acciones', 'AC-4'], ['alertas', 'AL-1']),
          edge('responde_a', ['acciones', 'AC-5'], ['demandas', 'D-1']),
          edge('responde_a', ['compromisos', 'C-1'], ['demandas', 'D-1'], true),
        ],
      ),
      [
        { module: 'eventos', id: 'EV-1' },
        { module: 'demandas', id: 'D-1' },
      ],
      TODAY,
    );
    expect(dossier.actions.map((a) => [a.id, a.overdue, a.due])).toEqual([
      ['AC-3', true, '2026-10-01'],
      ['AC-4', false, 'Pronto'],
      ['AC-5', false, ''],
    ]);
    expect(dossier.commitments[0]).toMatchObject({ id: 'C-1', progress: 40, overdue: true });
    expect(dossier.commitments[0]?.demands.map((d) => d.id)).toEqual(['D-1']);
    expect(dossier.attention.map((a) => [a.kind, a.ref.id])).toEqual([
      ['accion_vencida', 'AC-3'],
      ['accion_sin_resultado', 'AC-5'],
      ['compromiso_vencido', 'C-1'],
    ]);
    expect(dossier.attention.find((a) => a.ref.id === 'C-1')?.text).toBe(
      'Compromiso vencido el 2026-09-30 con 40% de avance.',
    );
  });

  it('lists unanswered demands and groups involved actors by type', () => {
    const community = node('actores', 'A-1', 'Comunidad San Martín', { Tipo_Actor: 'Comunidad' });
    const office = node('actores', 'A-2', 'Municipalidad Provincial', {
      Tipo_Actor: 'Institución pública',
    });
    const firm = node('actores', 'A-3', 'Contratista', { Tipo_Actor: 'Empresa' });
    const dossier = buildDossier(
      graph(
        [demand, observed, community, office, firm],
        [
          edge('plantea', ['actores', 'A-1'], ['demandas', 'D-1'], true),
          edge('participa_en', ['actores', 'A-2'], ['eventos', 'EV-1']),
        ],
      ),
      [
        { module: 'demandas', id: 'D-1' },
        { module: 'eventos', id: 'EV-1' },
        { module: 'actores', id: 'A-3' },
      ],
      TODAY,
    );
    expect(dossier.actors.map((a) => [a.id, a.group])).toEqual([
      ['A-1', 'comunidades'],
      ['A-3', 'otros'],
      ['A-2', 'instituciones'],
    ]);
    expect(dossier.attention.map((a) => [a.kind, a.ref.id])).toEqual([
      ['demanda_sin_respuesta', 'D-1'],
    ]);
  });

  it('ignores records that are not linked to a signal of the dossier', () => {
    const elsewhere = node('alertas', 'AL-9', 'Otra provincia', { Estado: 'Abierta' });
    const other = node('eventos', 'EV-9', 'Fuera del área', {});
    const dossier = buildDossier(
      graph(
        [observed, other, elsewhere],
        [edge('origina', ['eventos', 'EV-9'], ['alertas', 'AL-9'])],
        true,
      ),
      [{ module: 'eventos', id: 'EV-1' }],
      TODAY,
    );
    expect(dossier.alerts).toEqual([]);
    expect(dossier.signals.map((s) => s.id)).toEqual(['EV-1']);
    expect(dossier.truncated).toBe(true);
  });
});

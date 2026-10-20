import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/contexts/situations/domain/settings.ts';
import { dayOf, toSignal } from '../../src/contexts/situations/domain/signals.ts';
import {
  DEFAULT_RECOMMENDATIONS,
  findSituations,
  listNames,
} from '../../src/contexts/situations/domain/situations.ts';

const TODAY = '2026-10-19';
const ago = (days: number) =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** Synthetic records only. */
const employment = (shift = 0) => [
  {
    module: 'Demandas',
    id: 'D-1',
    payload: {
      Fecha_Registro: ago(shift + 1),
      Tema: 'Empleo local',
      'Actor/Grupo': 'Comunidad Norte',
      Descripcion: 'Solicitan contratación de mano de obra local',
      Prioridad: 'Alta',
    },
  },
  {
    module: 'Narrativas',
    id: 'N-1',
    payload: {
      Fecha_Inicio: ago(shift + 3),
      Tema: 'Trabajo para la zona',
      Actor_Relacionado: 'Frente de Defensa',
      Descripcion: 'Publicación reclama puestos de trabajo',
      Tono: 'Negativo',
    },
  },
  {
    module: 'Eventos',
    id: 'EV-1',
    payload: {
      Fecha: ago(shift + 5),
      Descripcion_Hecho: 'Reunión sobre empleo con la comunidad',
      Actor_Principal: 'Comunidad Norte',
    },
  },
];

describe('situations engine', () => {
  it('relates recent records on one topic and explains an orange alert', () => {
    const { situations } = findSituations(employment(), DEFAULT_SETTINGS, TODAY);
    const topic = situations.find((s) => s.key === 'tema:empleo local');
    expect(topic).toMatchObject({
      kind: 'tema',
      label: 'Empleo local',
      level: 'Naranja',
      trend: 'en aumento',
      actors: ['Comunidad Norte', 'Frente de Defensa'],
      records: [
        { module: 'Demandas', id: 'D-1', date: ago(1) },
        { module: 'Narrativas', id: 'N-1', date: ago(3) },
        { module: 'Eventos', id: 'EV-1', date: ago(5) },
      ],
    });
    expect(topic?.summary).toBe(
      'Naranja – Requiere intervención preventiva: existen 3 registros recientes relacionados con empleo local y participación de Comunidad Norte y Frente de Defensa, en aumento.',
    );
    expect(topic?.reasons[0]).toEqual({
      text: '3 registros relacionados con el tema «Empleo local» en 5 día(s).',
      records: ['Demandas:D-1', 'Narrativas:N-1', 'Eventos:EV-1'],
    });
    expect(topic?.reasons.map((r) => r.text)).toContain(
      'En aumento: 3 registro(s) en los últimos 7 días frente a 0 por semana en las 4 semanas anteriores; por eso el nivel sube de Amarillo a Naranja.',
    );
    expect(topic?.recommendations).toEqual([
      'Coordinar una reunión con los actores involucrados.',
      'Contactar a Comunidad Norte y Frente de Defensa para conocer su posición.',
      DEFAULT_RECOMMENDATIONS.seguimiento,
      DEFAULT_RECOMMENDATIONS.monitoreo,
      DEFAULT_RECOMMENDATIONS.narrativas,
      DEFAULT_RECOMMENDATIONS.verificar,
    ]);
    // The same two records grouped by the actor form their own situation.
    expect(situations.find((s) => s.key === 'actor:comunidad norte')?.records).toHaveLength(2);
  });

  it('gives old facts less weight than recent ones', () => {
    const recent = findSituations(employment(), DEFAULT_SETTINGS, TODAY).situations[0];
    const old = findSituations(employment(60), DEFAULT_SETTINGS, TODAY).situations.find(
      (s) => s.key === 'tema:empleo local',
    );
    expect(old).toMatchObject({ level: 'Verde', trend: 'estable' });
    expect(old?.score).toBeLessThan((recent?.score ?? 0) / 10);
    expect(findSituations(employment(120), DEFAULT_SETTINGS, TODAY).situations).toEqual([]);
  });

  it('never infers a territory from text, only from the recorded field', () => {
    const records = [
      {
        module: 'Eventos',
        id: 'E1',
        payload: { Fecha: ago(2), Descripcion_Hecho: 'Bloqueo en Comunidad Sur' },
      },
      {
        module: 'Eventos',
        id: 'E2',
        payload: { Fecha: ago(3), Descripcion_Hecho: 'Paro en Comunidad Sur' },
      },
    ];
    const keys = findSituations(records, DEFAULT_SETTINGS, TODAY).situations.map((s) => s.key);
    expect(keys).toEqual(['tema:movilizacion']);
    const withField = records.map((r) => ({ ...r, payload: { ...r.payload, Territorio: 'Sur' } }));
    const situations = findSituations(withField, DEFAULT_SETTINGS, TODAY).situations;
    expect(situations.map((s) => s.key)).toEqual(['tema:movilizacion']);
    expect(situations[0]?.territories).toEqual(['Sur']);
  });

  it('counts undated records apart and ignores alerts MASCLI 4.0 suggested', () => {
    const report = findSituations(
      [
        ...employment(),
        { module: 'Demandas', id: 'D-9', payload: { Tema: 'Empleo' } },
        {
          module: 'Alertas',
          id: 'AL-1',
          payload: { Fecha: ago(1), Causa: 'Empleo', Origen: 'MASCLI 4.0' },
        },
      ],
      DEFAULT_SETTINGS,
      TODAY,
    );
    expect(report.undated).toBe(1);
    expect(report.considered).toBe(3);
  });

  it('reports a change of narrative tone', () => {
    const narrative = (id: string, days: number, tone: string) => ({
      module: 'Narrativas',
      id,
      payload: { Fecha_Inicio: ago(days), Tema: 'Agua', Descripcion: 'Agua del río', Tono: tone },
    });
    const { situations, narratives } = findSituations(
      [
        narrative('N1', 40, 'Neutral'),
        narrative('N2', 50, 'Positivo'),
        narrative('N3', 2, 'Negativo'),
        narrative('N4', 4, 'Negativo'),
      ],
      DEFAULT_SETTINGS,
      TODAY,
    );
    expect(situations[0]?.reasons.map((r) => r.text)).toContain(
      'Cambio de narrativa: el tono negativo pasa de 0 % a 100 % en las publicaciones más recientes.',
    );
    expect(narratives).toEqual({
      total: 4,
      recent: 2,
      topics: [{ name: 'Agua', count: 4, recent: 2 }],
      platforms: [],
      tone: { now: 100, then: 0 },
    });
  });

  it('reads dd/mm/yyyy dates and rejects impossible ones', () => {
    expect(dayOf('05/10/2026')).toBe('2026-10-05');
    expect(dayOf('2026-02-30')).toBeNull();
    expect(toSignal({ module: 'Otro', id: 'x', payload: {} }, TODAY)).toBeNull();
    expect(listNames(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C y 2 más');
  });
});

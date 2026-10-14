import { describe, expect, it } from 'vitest';
import {
  type Connection,
  type Subject,
  briefingText,
  buildBriefing,
  citedRefs,
} from '../../src/contexts/analyst/domain/briefing.ts';

const subject = (over: Partial<Subject> & Pick<Subject, 'slug' | 'id'>): Subject => ({
  typeLabel: over.slug,
  title: over.id,
  date: null,
  marking: 'interno',
  fields: {},
  ...over,
});
const connect = (
  other: Subject,
  label = 'se vincula con',
  over: Partial<Connection> = {},
): Connection => ({
  linkType: 'relacionado_con',
  label,
  inferred: false,
  other,
  ...over,
});

const actor = subject({
  slug: 'actores',
  id: 'A-1',
  typeLabel: 'Actor',
  title: 'Comunidad Norte',
  fields: { Posicion_Proyecto: 'En contra', Territorio: 'Valle' },
});

describe('extractive briefings', () => {
  it('cites the subject for its own facts and numbers sources in order of appearance', () => {
    const briefing = buildBriefing(actor, [], '2026-10-14');
    expect(briefing.sources).toEqual([
      { ref: 1, slug: 'actores', id: 'A-1', typeLabel: 'Actor', title: 'Comunidad Norte' },
    ]);
    const [overview, network, signals] = briefing.sections;
    expect(overview?.sentences[0]).toEqual({ text: 'Actor «Comunidad Norte».', refs: [1] });
    expect(overview?.sentences).toContainEqual({ text: 'Territorio: Valle.', refs: [1] });
    expect(network?.sentences[0]?.text).toMatch(/No tiene vínculos/);
    expect(signals?.title).toBe('Señales de atención');
    expect(signals?.sentences[0]).toEqual({
      text: 'Actor «Comunidad Norte» mantiene una posición En contra.',
      refs: [1],
    });
  });

  it('summarizes links, builds a dated timeline and flags overdue, severe and conflicting records', () => {
    const overdue = subject({
      slug: 'compromisos',
      id: 'C-1',
      typeLabel: 'Compromiso',
      title: 'Pozo comunal',
      date: '2026-08-01',
      fields: { Plazo: '2026-09-30', Estado: 'En curso' },
    });
    const met = subject({
      slug: 'compromisos',
      id: 'C-2',
      typeLabel: 'Compromiso',
      title: 'Taller',
      fields: { Plazo: '2026-01-01', Estado: 'Cumplido' },
    });
    const alert = subject({
      slug: 'alertas',
      id: 'AL-1',
      typeLabel: 'Alerta',
      title: 'Bloqueo de vía',
      date: '2026-10-10',
      fields: { Nivel_Preliminar: 'Alto', Estado: 'Abierta' },
    });
    const rival = subject({ slug: 'actores', id: 'A-2', typeLabel: 'Actor', title: 'Frente Sur' });
    const hidden = subject({
      slug: 'fuentes',
      id: 'F-9',
      typeLabel: 'Fuente',
      marking: 'restringido',
    });
    const connections = [
      connect(overdue, 'asume'),
      connect(met, 'asume'),
      connect(alert, 'origina', { inferred: true }),
      connect(rival, 'en conflicto con', { linkType: 'en_conflicto_con' }),
      connect(hidden, 'se sustenta en'),
    ];
    const briefing = buildBriefing(actor, connections, '2026-10-14');
    const byTitle = Object.fromEntries(briefing.sections.map((s) => [s.title, s.sentences]));
    expect(byTitle['Red de vínculos']?.slice(0, 3).map((s) => s.text)).toEqual([
      'Tiene 5 vínculos con 5 registros.',
      'asume: 2 registros.',
      'en conflicto con: 1 registro.',
    ]);
    expect(byTitle['Red de vínculos']?.map((s) => s.text)).toContain(
      'origina: 1 registro (1 inferido de los datos).',
    );
    expect(byTitle['Cronología']?.map((s) => s.text)).toEqual([
      '2026-10-10: Alerta «Bloqueo de vía».',
      '2026-08-01: Compromiso «Pozo comunal».',
    ]);
    const signals = byTitle['Señales de atención']?.map((s) => s.text) ?? [];
    expect(signals).toEqual([
      'Actor «Comunidad Norte» mantiene una posición En contra.',
      'Compromiso «Pozo comunal» venció el 2026-09-30 sin cerrarse.',
      'Alerta «Bloqueo de vía» sigue abierta con nivel Alto.',
      'Hay un conflicto registrado con Actor «Frente Sur».',
      '1 vínculo apunta a información restringida.',
    ]);
    // Every citation points at a listed source.
    const refs = new Set(briefing.sources.map((s) => s.ref));
    for (const section of briefing.sections)
      for (const sentence of section.sentences)
        for (const ref of sentence.refs) expect(refs.has(ref)).toBe(true);
    // Input order does not change the text.
    expect(buildBriefing(actor, [...connections].reverse(), '2026-10-14')).toEqual(briefing);
  });

  it('renders text with citation markers and validates citations of a narrative', () => {
    const briefing = buildBriefing(
      actor,
      [connect(subject({ slug: 'fuentes', id: 'F-1' }))],
      '2026-10-14',
    );
    const text = briefingText(briefing);
    expect(text).toContain('- Actor «Comunidad Norte». [1]');
    expect(text).toContain('[2] fuentes F-1: F-1');
    expect(citedRefs('Según el acta [2], la comunidad [1][2] se opone.', briefing)).toEqual([1, 2]);
    expect(citedRefs('Sin citas.', briefing)).toEqual([]);
    expect(citedRefs('Dato inventado [7].', briefing)).toBeNull();
  });
});

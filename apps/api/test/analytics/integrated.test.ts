import { describe, expect, it } from 'vitest';
import {
  candidatePairs,
  recordLinks,
  thematicTerms,
} from '../../src/contexts/analytics/domain/candidate-links.ts';
import { integratedAnalysis } from '../../src/contexts/analytics/domain/integrated.ts';
import {
  type ExtendedRecords,
  emptyExtended,
  extendedRecords,
} from '../../src/contexts/analytics/domain/records.ts';

const AT = '2026-10-12T12:00:00Z';
const records = (partial: Partial<ExtendedRecords>): ExtendedRecords => ({
  ...emptyExtended(),
  ...partial,
});
const r = (id: string, fields: Record<string, unknown> = {}) => ({ ...fields, _id: id });

describe('thematicTerms (app.py:848)', () => {
  it('normalizes accents, keeps 4+ letter tokens and drops stopwords', () => {
    expect([...thematicTerms('Contaminación del AGUA para pesca, río y comunidad')].sort()).toEqual(
      ['agua', 'contaminacion', 'pesca'],
    );
    expect(thematicTerms(null).size).toBe(0);
  });
});

describe('recordLinks (app.py:853)', () => {
  it('links by explicit ID equality ignoring case and whitespace', () => {
    expect(recordLinks(r('a', { ID_Actor: ' act-1 ' }), r('b', { ID_Actor: 'ACT-1' }))).toEqual([
      'referencia explícita',
      ['ID_Actor'],
    ]);
    expect(recordLinks(r('a', { ID_Actor: '' }), r('b', { ID_Actor: '' }))).toBeNull();
  });

  it('links by cross references to the other record or a shared reference', () => {
    expect(recordLinks(r('a', { Registros_Relacionados: 'x, b' }), r('b'))?.[0]).toBe(
      'referencia cruzada',
    );
    expect(recordLinks(r('a'), r('b', { Referencias_ID: 'a' }))?.[0]).toBe('referencia cruzada');
    expect(
      recordLinks(r('a', { Referencias_ID: 'R1,R2' }), r('b', { Referencias_ID: ' R2 ' }))?.[0],
    ).toBe('referencia cruzada');
    expect(
      recordLinks(r('a', { Referencias_ID: 'R1' }), r('b', { Referencias_ID: 'R3' })),
    ).toBeNull();
  });
});

describe('candidatePairs (app.py:862)', () => {
  it('requires a link or at least two shared accent-insensitive terms', () => {
    const pairs = candidatePairs(
      records({
        intereses: [
          r('i1', { Interes: 'Pesca artesanal', Preocupacion: 'contaminación marina' }),
          r('i2', { Interes: 'Pesca deportiva' }),
        ],
        oportunidades: [r('o1', { Oportunidad: 'Contaminacion', Beneficiarios: 'PESCA' })],
      }),
    );
    expect(pairs).toEqual([
      {
        origen: 'intereses/i1',
        destino: 'oportunidades/o1',
        criterio: 'coincidencia léxica (no implica relación probada)',
        terminos_compartidos: ['contaminacion', 'pesca'],
        estado: 'Hipótesis de vínculo; verificar con fuentes y participantes',
        uso_sugerido:
          'Revisar pertinencia del vínculo, intereses expresados y posibles restricciones antes de diseñar opciones',
      },
    ]);
  });

  it('uses the link rule when records reference each other explicitly', () => {
    const pairs = candidatePairs(
      records({
        hechos: [r('h1', { ID_Proceso: 'P1', Asunto: 'agua' })],
        dialogos: [r('d1', { ID_Proceso: 'p1', Tema: 'agua' })],
      }),
    );
    expect(pairs.map((p) => [p.origen, p.destino, p.criterio, p.terminos_compartidos])).toEqual([
      ['hechos/h1', 'dialogos/d1', 'referencia explícita', ['agua']],
    ]);
  });

  it('caps the output at 120 pairs', () => {
    const many = Array.from({ length: 12 }, (_, i) => r(`x${i}`, { Vinculo_ID: 'V' }));
    const pairs = candidatePairs(records({ intereses: many, oportunidades: many }));
    expect(pairs).toHaveLength(120);
  });
});

describe('integratedAnalysis (app.py:881)', () => {
  it('composes candidate links, numbered action plan and totals', () => {
    const result = integratedAnalysis(
      records({
        hechos: [r('h1', { Asunto: 'agua potable', Fuente_ID: 'F', Estado: 'validado' })],
        dialogos: [
          r('d1', { Tema: 'Agua potable', Responsable: 'Ana', Proximo_Paso: 'x', Fuente_ID: 'F' }),
        ],
      }),
      'PRJ-SECHURA',
      AT,
    );
    expect(result.version).toBe('1.9');
    expect(result.summary).toEqual({
      cruces_candidatos: 1,
      acciones_sugeridas: 1,
      registros_estrategicos: 2,
    });
    expect(result.action_plan).toEqual([
      {
        numero: 1,
        accion:
          'Preguntar a los participantes qué hechos necesitan verificar juntos y acordar un procedimiento transparente.',
        objetivo: 'Incluir controversias verificables en la agenda de diálogo',
        fundamento:
          'El proyecto registra tanto procesos de diálogo como asuntos sujetos a verificación.',
        registros: ['h1', 'd1'],
        prioridad_orientativa: 'Media',
        responsable: 'Por asignar tras revisión',
        plazo: 'Por acordar',
        estado: 'Borrador automático — no aprobado',
      },
    ]);
    expect(result.scenarios.map((s) => s.tipo)).toEqual([
      'Escenario de mejora',
      'Escenario de continuidad',
      'Escenario de deterioro',
    ]);
    expect(result.limitations).toHaveLength(4);
  });
});

describe('extendedRecords project filter (app.py:709)', () => {
  it('defaults only missing Proyecto_ID to PRJ-SECHURA and newest-first order is kept', () => {
    const result = extendedRecords(
      {
        Intereses: [
          { id: 'i1', payload: { Actor: 'A' } },
          { id: 'i2', payload: { Proyecto_ID: 'PRJ-OTRO' } },
          { id: 'i3', payload: { Proyecto_ID: '' } },
          { id: 'i4', payload: { Proyecto_ID: 'PRJ-SECHURA', _id: 'spoof' } },
        ],
      },
      'PRJ-SECHURA',
    );
    expect(result.intereses).toEqual([
      { Actor: 'A', _id: 'i1' },
      { Proyecto_ID: 'PRJ-SECHURA', _id: 'i4' },
    ]);
    expect(result.hechos).toEqual([]);
  });
});

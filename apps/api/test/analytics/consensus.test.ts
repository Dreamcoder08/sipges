import { describe, expect, it } from 'vitest';
import { automatedConsensus } from '../../src/contexts/analytics/domain/consensus.ts';
import {
  type ExtendedRecords,
  emptyExtended,
} from '../../src/contexts/analytics/domain/records.ts';
import { strategicAssessment } from '../../src/contexts/analytics/domain/strategic.ts';

const AT = '2026-10-12T12:00:00Z';
const records = (partial: Partial<ExtendedRecords>): ExtendedRecords => ({
  ...emptyExtended(),
  ...partial,
});
const r = (id: string, fields: Record<string, unknown> = {}) => ({ ...fields, _id: id });
const titles = (partial: Partial<ExtendedRecords>) =>
  automatedConsensus(records(partial), 'PRJ-SECHURA', AT).recommendations.map((c) => [
    c.tipo,
    c.origen,
    c.prioridad_orientativa,
  ]);

const COMPLETE_AARC = {
  Reconocimiento: 'x',
  Agencia: 'x',
  Reciprocidad: 'x',
  Claridad: 'x',
};

describe('automatedConsensus rule families (app.py:745)', () => {
  it('hechos: unvalidated fact and missing source', () => {
    expect(titles({ hechos: [r('h1', { Estado: ' Pendiente ' })] })).toEqual([
      ['Hechos compartidos', 'hechos/h1', 'Alta'],
      ['Calidad de evidencia', 'hechos/h1', 'Alta'],
    ]);
    expect(titles({ hechos: [r('h2', { Estado: ' VALIDADO ', Fuente_ID: 'F1' })] })).toEqual([]);
  });

  it('intereses: missing interest, mandate, and unsourced concern', () => {
    const result = automatedConsensus(
      records({ intereses: [r('i1', { Actor: 'Gremio', Preocupacion: 'agua' })] }),
      'PRJ-SECHURA',
      AT,
    );
    expect(result.recommendations.map((c) => [c.tipo, c.motivo, c.prioridad_orientativa])).toEqual([
      [
        'Negociación por intereses',
        'El actor Gremio tiene una ficha sin interés documentado.',
        'Media',
      ],
      [
        'Representatividad',
        'La ficha de Gremio no registra sustento documental de mandato.',
        'Alta',
      ],
      ['Información compartida', 'Se registró una preocupación sin fuente trazable.', 'Media'],
    ]);
    expect(
      automatedConsensus(records({ intereses: [r('i2')] }), 'PRJ-SECHURA', AT).recommendations[0]
        ?.motivo,
    ).toBe('El actor i2 tiene una ficha sin interés documentado.');
  });

  it('dialogos: open process without follow-up or source; closed ones are skipped', () => {
    expect(titles({ dialogos: [r('d1', { Responsable: 'Ana' })] })).toEqual([
      ['Arquitectura de consenso', 'dialogos/d1', 'Alta'],
      ['Trazabilidad', 'dialogos/d1', 'Media'],
    ]);
    expect(titles({ dialogos: [r('d2', { Estado: 'Finalizado' })] })).toEqual([]);
  });

  it('oportunidades: viability and owner', () => {
    expect(titles({ oportunidades: [r('o1', { Viabilidad: 'alta' })] })).toEqual([
      ['Mutual Gains / valor compartido', 'oportunidades/o1', 'Media'],
      ['Gobernanza adaptativa', 'oportunidades/o1', 'Media'],
    ]);
    expect(titles({ oportunidades: [r('o2', { Estado: 'Descartada' })] })).toEqual([]);
  });

  it('aarc: missing dimensions listed in order, else missing evidence', () => {
    const result = automatedConsensus(
      records({ aarc: [r('a1', { Agencia: 'x' }), r('a2', COMPLETE_AARC)] }),
      'PRJ-SECHURA',
      AT,
    );
    expect(result.recommendations.map((c) => [c.tipo, c.motivo])).toEqual([
      [
        'AARC / relacionamiento',
        'Dimensiones sin documentación: reconocimiento, reciprocidad, claridad.',
      ],
      ['AARC / evidencia', 'La evaluación registra las cuatro dimensiones sin evidencia indicada.'],
    ]);
    expect(titles({ aarc: [r('a3', { ...COMPLETE_AARC, Evidencia: 'acta' })] })).toEqual([]);
  });

  it('cross-module rules relate the first records of each module', () => {
    const complete = { Interes: 'x', Mandato: 'x' };
    const opportunity = { Viabilidad: 'x', Restricciones: 'x', Responsable: 'x' };
    const result = automatedConsensus(
      records({
        intereses: ['i1', 'i2', 'i3', 'i4'].map((id) => r(id, complete)),
        oportunidades: [r('o1', opportunity)],
        hechos: [
          r('h1', { Estado: 'validado', Fuente_ID: 'F' }),
          r('h2', { Estado: 'validado', Fuente_ID: 'F' }),
        ],
        dialogos: [r('d1', { Estado: 'cerrado' })],
      }),
      'PRJ-SECHURA',
      AT,
    );
    expect(result.recommendations.map((c) => [c.origen, c.registros_relacionados])).toEqual([
      ['intereses+oportunidades', ['i1', 'i2', 'i3', 'o1']],
      ['hechos+dialogos', ['h1', 'd1']],
    ]);
  });

  it('deduplicates by type, origin and title and summarises priorities', () => {
    const dup = r('h1', { Estado: 'abierto' });
    const result = automatedConsensus(records({ hechos: [dup, dup] }), 'PRJ-NORTE', AT);
    expect(result.recommendations).toHaveLength(2);
    expect(result.summary).toEqual({ total: 2, alta: 2 });
    expect(result.project_id).toBe('PRJ-NORTE');
    expect(result.counts).toEqual({
      intereses: 0,
      dialogos: 0,
      oportunidades: 0,
      hechos: 2,
      aarc: 0,
    });
    expect(result.method).toBe(
      'reglas trazables v1.8 (sin inferencia predictiva ni IA generativa)',
    );
    expect(result.recommendations[0]).toEqual({
      tipo: 'Hechos compartidos',
      titulo: 'Preparar verificación conjunta de información',
      motivo:
        'El asunto consta como no validado; no se debe resolver una controversia a partir de una sola versión.',
      accion_sugerida:
        'Acordar preguntas, fuentes, metodología, responsables y criterios de validación con los actores participantes.',
      origen: 'hechos/h1',
      registros_relacionados: ['h1'],
      prioridad_orientativa: 'Alta',
      estado: 'Propuesta automática; pendiente de revisión humana',
      autorizacion: 'No constituye acuerdo ni compromiso',
    });
  });
});

describe('strategicAssessment (app.py:715)', () => {
  it('counts pending facts, open items and complete AARC with attention notes', () => {
    const result = strategicAssessment(
      records({
        hechos: [r('h1', { Estado: 'Validado' }), r('h2')],
        oportunidades: [r('o1', { Estado: 'cerrada' }), r('o2')],
        dialogos: [r('d1')],
        aarc: [r('a1', COMPLETE_AARC), r('a2', { ...COMPLETE_AARC, Claridad: ' ' })],
      }),
      'PRJ-SECHURA',
      AT,
    );
    expect(result).toMatchObject({
      project_id: 'PRJ-SECHURA',
      generated_at: AT,
      counts: { intereses: 0, dialogos: 1, oportunidades: 2, hechos: 2, aarc: 2 },
      facts_pending: 1,
      opportunities_open: 1,
      dialogues_open: 1,
      aarc_complete: 1,
      attention: [
        'Existen hechos o datos pendientes de contraste documental y validación conjunta.',
        'Existen procesos de diálogo registrados que requieren seguimiento.',
        'Existen oportunidades registradas cuya viabilidad y responsables deben revisarse.',
      ],
    });
    expect(result.limitations).toHaveLength(3);
    expect(strategicAssessment(records({}), 'PRJ-SECHURA', AT).attention).toEqual([]);
  });
});

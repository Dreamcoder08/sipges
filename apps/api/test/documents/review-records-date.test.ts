import { describe, expect, it } from 'vitest';
import { type ReviewItem, reviewRecordFields } from '../../src/contexts/documents/domain/index.ts';

// The record an approved finding creates is dated with the decision's calendar day in Peru
// (UTC−5), not the UTC date. Synthetic items only.

const item = (theme: string, decidedAt: string): ReviewItem => ({
  id: 'itemsintetico',
  projectId: 'PRJ-SINTETICO',
  sourceFile: 'acta-sintetica.txt',
  sourceSha256: 'a'.repeat(64),
  location: 'Línea 1',
  theme,
  excerpt: 'Fragmento sintético',
  action: '',
  status: 'aceptado_para_revision',
  reviewer: 'revisora',
  note: '',
  createdAt: new Date('2026-11-01T15:00:00Z'),
  updatedAt: new Date(decidedAt),
});

describe('review record date is the Lima calendar day of the decision', () => {
  it.each([
    ['2026-11-13T23:30:00-05:00', '2026-11-13'],
    ['2026-11-30T23:30:00-05:00', '2026-11-30'],
    ['2026-12-31T23:30:00-05:00', '2026-12-31'],
  ])('decided at %s is dated %s in every dated module', (decidedAt, day) => {
    expect(
      reviewRecordFields(item('Demandas e intereses', decidedAt), 'PRJ-SINTETICO'),
    ).toMatchObject({ Fecha_Registro: day });
    expect(
      reviewRecordFields(item('Compromisos y trazabilidad', decidedAt), 'PRJ-SINTETICO'),
    ).toMatchObject({ Fecha: day });
    expect(
      reviewRecordFields(item('Territorio y ambiente', decidedAt), 'PRJ-SINTETICO'),
    ).toMatchObject({ Fecha_Observacion: day });
  });
});

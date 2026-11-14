import { limaToday } from '@sipges/kernel';
import { describe, expect, it } from 'vitest';
import {
  type ReviewItem,
  reviewRecordFields,
  reviewTarget,
} from '../../src/contexts/documents/domain/index.ts';
import { toSignal } from '../../src/contexts/situations/domain/signals.ts';

// A record created from a finding approved in the Lima evening must reach the situations reading
// as a signal of that same day: a UTC-dated record would be "in the future" and drop out.
// Synthetic items only.

const decidedAt = new Date('2026-11-13T23:30:00-05:00');

const item = (theme: string): ReviewItem => ({
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
  updatedAt: decidedAt,
});

describe('an approved finding feeds situations with the Lima day', () => {
  it.each(['Demandas e intereses', 'Compromisos y trazabilidad', 'Territorio y ambiente'])(
    '%s approved at 23:30 Lima is a signal dated that day, 0 days old',
    (theme) => {
      const finding = item(theme);
      const signal = toSignal(
        {
          module: reviewTarget(theme).label,
          id: 'REV-itemsintetico',
          payload: reviewRecordFields(finding, 'PRJ-SINTETICO'),
        },
        limaToday(decidedAt),
      );
      expect(signal).toMatchObject({ date: '2026-11-13', ageDays: 0 });
    },
  );
});

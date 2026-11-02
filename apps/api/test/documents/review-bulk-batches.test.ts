import { describe, expect, it } from 'vitest';
import {
  type ReviewItem,
  type ReviewRecordWriter,
  type ReviewStore,
  createDocumentLabService,
} from '../../src/contexts/documents/application/index.ts';

// T26: a bulk decision runs in transactions of 200 and stops at 1,000 per request. Synthetic.

const item = (n: number): ReviewItem => ({
  id: `item${String(n).padStart(5, '0')}`,
  projectId: 'PRJ-SINTETICO',
  sourceFile: 'acta.txt',
  sourceSha256: 'a'.repeat(64),
  location: `Línea ${n}`,
  theme: 'Demandas e intereses',
  excerpt: `Fragmento ${n}`,
  action: '',
  status: 'pendiente',
  reviewer: '',
  note: '',
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const setup = (pending: number, failing: string | null = null) => {
  // Odd items go to Narrativas so a batch spans two modules.
  let queue = Array.from({ length: pending }, (_, n) =>
    n % 2 ? { ...item(n), theme: 'Territorio y ambiente' } : item(n),
  );
  const limits: number[] = [];
  const recordCalls: number[] = [];
  const reviews = {
    pending: async (_t, s, limit) =>
      queue.filter((i) => !s.ids || s.ids.includes(i.id)).slice(0, limit),
    countPending: async () => queue.length,
    decidePending: async (_t, s, decision, limit) => {
      limits.push(limit);
      const picked = queue.filter((i) => !s.ids || s.ids.includes(i.id)).slice(0, limit);
      queue = queue.filter((i) => !picked.includes(i));
      return picked.map((i) => ({ ...i, ...decision, updatedAt: decision.at }));
    },
  } as Pick<ReviewStore, 'pending' | 'countPending' | 'decidePending'> as ReviewStore;
  const records: ReviewRecordWriter = {
    createMissing: async (_t, module, rows) => {
      if (module === failing) throw new Error('synthetic records failure');
      recordCalls.push(rows.length);
      return { created: rows.length, existing: 0, problems: [] };
    },
    existing: async () => new Set(),
  };
  const lab = createDocumentLabService({
    reader: {} as never,
    renderer: {} as never,
    reviews,
    records,
    clock: { now: () => new Date('2026-11-02T00:00:00Z') },
    randomHex: () => '0',
    maxUploadBytes: 1,
  });
  const decide = (ids: string[] | null) =>
    lab.decideMany('SINTETICO/PRJ-SINTETICO', {
      projectId: 'PRJ-SINTETICO',
      ids,
      theme: ids ? null : 'Demandas e intereses',
      sourceSha256: null,
      status: 'aceptado_para_revision',
      reviewer: 'Revisora',
      note: '',
      dryRun: false,
    });
  return { decide, limits, recordCalls };
};

describe('bulk decision batches (T26)', () => {
  it('takes a filter in transactions of 200 up to 1,000 and reports the rest', async () => {
    const { decide, limits, recordCalls } = setup(1250);
    const result = await decide(null);
    expect(result.ok && result.value).toMatchObject({ decided: 1000, remaining: 250 });
    expect(limits).toEqual([200, 200, 200, 200, 200]);
    // Each batch of 200 writes two modules of 100.
    expect(recordCalls).toEqual(Array.from({ length: 10 }, () => 100));
  });

  it('stops early when a batch comes back short', async () => {
    const { decide, limits } = setup(450);
    const result = await decide(null);
    expect(result.ok && result.value).toMatchObject({ decided: 450, remaining: 0 });
    expect(limits).toEqual([200, 200, 200]);
  });

  it('splits explicit ids into chunks of 200 and counts duplicates once', async () => {
    const { decide, limits } = setup(500);
    const ids = Array.from({ length: 450 }, (_, n) => item(n).id);
    const result = await decide([...ids, ids[0] ?? '']);
    expect(result.ok && result.value).toMatchObject({ decided: 450, skipped: 0 });
    expect(limits).toEqual([200, 200, 200]);
  });

  it('keeps the counts of the modules that were written when another one fails', async () => {
    const { decide } = setup(4, 'narrativas');
    const result = await decide(null);
    expect(result.ok && result.value).toMatchObject({
      decided: 4,
      recordsCreated: 2,
      problems: ['narrativas: 2 hallazgos decididos sin registro: use review:materialize'],
    });
  });
});

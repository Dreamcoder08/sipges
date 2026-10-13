import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { syntheticPages, syntheticPdf } from '../../bench/synthetic.ts';
import {
  type PdfWorkerPool,
  createPdfWorkerPool,
} from '../../src/contexts/documents/infrastructure/pdf-worker-pool.ts';
import { minimalPdf } from './fixtures.ts';

const pools: PdfWorkerPool[] = [];
const pool = (options: Parameters<typeof createPdfWorkerPool>[0] = {}) => {
  const created = createPdfWorkerPool(options);
  pools.push(created);
  return created;
};
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});

const HANGING = new URL('./workers/hanging-worker.ts', import.meta.url);

describe('PDF worker pool', () => {
  it('extracts text off the main thread and keeps the caller bytes intact', async () => {
    const bytes = minimalPdf(['Primera pagina', 'Segunda pagina']);
    const before = [...bytes];
    const result = await pool({ size: 2 }).read(bytes, 100);
    expect(result).toEqual({ kind: 'pages', pages: ['Primera pagina', 'Segunda pagina'] });
    expect([...bytes]).toEqual(before);
  });

  it('refuses documents over the page limit and reports unreadable ones', async () => {
    const workers = pool({ size: 1 });
    expect(await workers.read(minimalPdf(['a', 'b', 'c']), 2)).toEqual({ kind: 'too_many_pages' });
    await expect(workers.read(new TextEncoder().encode('not a pdf'), 10)).rejects.toThrow();
    // The worker survives a failed job.
    expect(await workers.read(minimalPdf(['ok']), 10)).toEqual({ kind: 'pages', pages: ['ok'] });
  });

  it('keeps the event loop responsive while a 100-page PDF is parsed', async () => {
    const pdf = syntheticPdf(syntheticPages(100));
    const workers = pool({ size: 1 });
    await workers.read(minimalPdf(['warm up']), 1);
    let longestGap = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - last);
      last = now;
    }, 5);
    const result = await workers.read(pdf, 100);
    clearInterval(ticker);
    expect(result.kind === 'pages' && result.pages).toHaveLength(100);
    expect(longestGap).toBeLessThan(150);
  });

  it('terminates a worker that exceeds the timeout and starts a new one', async () => {
    const workers = pool({ size: 1, timeoutMs: 100, workerUrl: HANGING });
    await expect(workers.read(minimalPdf(['x']), 1)).rejects.toThrow('PDF extraction timed out');
    await expect(workers.read(minimalPdf(['x']), 1)).rejects.toThrow('PDF extraction timed out');
  });

  it('rejects pending jobs when a worker exits', async () => {
    const workers = pool({ size: 1, workerUrl: HANGING });
    await expect(workers.read(minimalPdf(['x']), 0)).rejects.toThrow('PDF worker stopped');
  });
});

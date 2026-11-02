import { HttpResponse, http } from 'msw';
import { beforeEach, expect, it } from 'vitest';
import { resetApi, server } from '../../../test/server.ts';
import { fetchRecordsSummary } from '../api.ts';

const COUNTS = {
  eventos: 501,
  actores: 0,
  directorio: 0,
  demandas: 0,
  narrativas: 0,
  fuentes: 0,
  buzon: 0,
};
const row = (n: number) => ({
  module: 'eventos',
  id: `EV-${n}`,
  title: `Evento sintético ${n}`,
  territory: '',
  date: '',
  verification: null,
  validation: '',
  updated_at: '2026-10-01T00:00:00Z',
});

beforeEach(() => resetApi());

it('follows the bounded pages of the summary for the active project', async () => {
  const seen: { offset: string | null; limit: string | null; scope: string | null }[] = [];
  server.use(
    http.get('/api/registros/summary', ({ request }) => {
      const url = new URL(request.url);
      const offset = Number(url.searchParams.get('offset'));
      seen.push({
        offset: url.searchParams.get('offset'),
        limit: url.searchParams.get('limit'),
        scope: request.headers.get('X-SIPGES-Scope'),
      });
      const rows = Array.from({ length: offset === 0 ? 500 : 1 }, (_, n) => row(offset + n));
      return HttpResponse.json({ counts: COUNTS, rows });
    }),
  );
  const summary = await fetchRecordsSummary('ACME/P1');
  expect(summary.rows).toHaveLength(501);
  expect(summary.rows[500]).toMatchObject({ id: 'EV-500', verification: null });
  expect(summary.counts).toEqual(COUNTS);
  expect(seen).toEqual([
    { offset: '0', limit: '500', scope: 'ACME/P1' },
    { offset: '500', limit: '500', scope: 'ACME/P1' },
  ]);
});

it('rejects a response that breaks the contract', async () => {
  server.use(
    http.get('/api/registros/summary', () =>
      HttpResponse.json({ counts: COUNTS, rows: [{ ...row(1), verification: 'Z' }] }),
    ),
  );
  await expect(fetchRecordsSummary('ACME/P1')).rejects.toThrow();
});

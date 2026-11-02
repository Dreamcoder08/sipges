import { SUMMARY_MODULES } from '@sipges/contracts';
import { HttpResponse, http } from 'msw';
import { summarize } from '../features/records/hub/summary.ts';
import { api, server } from './server.ts';

type Row = Record<string, unknown> & { _id: string };
export const installRecordsApi = (initial: Record<string, Row[]> = {}) => {
  const rows: Record<string, Row[]> = structuredClone(initial);
  const payloads: Record<string, unknown>[] = [];
  const key = (request: Request, module: string) =>
    `${request.headers.get('X-SIPGES-Scope') ?? api.scope}/${module}`;
  server.use(
    // Registros «Todos»: every hub type of the request's scope, in chip order, paged.
    http.get('/api/registros/summary', ({ request }) => {
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get('limit') ?? 200);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const all = SUMMARY_MODULES.flatMap((module) =>
        (rows[key(request, module)] ?? []).map((row) => ({
          ...summarize(module, row),
          updated_at: '2026-10-01T00:00:00Z',
        })),
      );
      return HttpResponse.json({
        counts: Object.fromEntries(
          SUMMARY_MODULES.map((module) => [module, (rows[key(request, module)] ?? []).length]),
        ),
        rows: all.slice(offset, offset + limit),
      });
    }),
    http.get('/api/:module', ({ request, params }) => {
      const q = new URL(request.url).searchParams.get('q')?.toLowerCase() ?? '';
      return HttpResponse.json(
        (rows[key(request, String(params.module))] ?? []).filter((row) =>
          JSON.stringify(row).toLowerCase().includes(q),
        ),
      );
    }),
    http.get('/api/:module/:id', ({ request, params }) => {
      const row = (rows[key(request, String(params.module))] ?? []).find(
        (r) => r._id === params.id,
      );
      return row
        ? HttpResponse.json(row)
        : HttpResponse.json({ detail: 'Registro no encontrado' }, { status: 404 });
    }),
    http.post('/api/:module', async ({ request, params }) => {
      const { payload } = (await request.json()) as { payload: Record<string, unknown> };
      payloads.push(payload);
      const k = key(request, String(params.module));
      const list = (rows[k] ??= []);
      const id = `REC-${list.length + 1}`;
      list.push({ ...payload, _id: id });
      return HttpResponse.json({ ok: true, id });
    }),
    http.put('/api/:module/:id', async ({ request, params }) => {
      const { payload } = (await request.json()) as { payload: Record<string, unknown> };
      payloads.push(payload);
      const list = rows[key(request, String(params.module))] ?? [];
      const index = list.findIndex((r) => r._id === params.id);
      if (index < 0)
        return HttpResponse.json({ detail: 'Registro no encontrado' }, { status: 404 });
      list[index] = { ...payload, _id: String(params.id) };
      return HttpResponse.json({ ok: true });
    }),
    http.delete('/api/:module/:id', ({ request, params }) => {
      const k = key(request, String(params.module));
      rows[k] = (rows[k] ?? []).filter((r) => r._id !== params.id);
      return HttpResponse.json({ ok: true });
    }),
    http.get('/system/uploads', () => HttpResponse.json([])),
    http.get('/api/:module/:id/history', () => HttpResponse.json([])),
    http.get('/system/ontology', () => HttpResponse.json({ object_types: [], link_types: [] })),
    http.get('/system/graph', ({ request }) => {
      const url = new URL(request.url);
      const root = {
        module: url.searchParams.get('module') ?? '',
        id: url.searchParams.get('id') ?? '',
      };
      return HttpResponse.json({ root, nodes: [], edges: [], truncated: false });
    }),
    http.get('/system/links', ({ request }) => {
      const url = new URL(request.url);
      const module = url.searchParams.get('module') ?? '';
      const id = url.searchParams.get('id') ?? '';
      return HttpResponse.json({
        record: {
          module,
          id,
          type_label: module,
          title: id,
          date: null,
          marking: 'interno',
          fields: {},
        },
        links: [],
      });
    }),
  );
  return { rows, payloads };
};

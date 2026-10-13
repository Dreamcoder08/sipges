import { HttpResponse, http } from 'msw';
import { api, server } from './server.ts';

type Row = Record<string, unknown> & { _id: string };
export const installRecordsApi = (initial: Record<string, Row[]> = {}) => {
  const rows: Record<string, Row[]> = structuredClone(initial);
  const payloads: Record<string, unknown>[] = [];
  const key = (request: Request, module: string) =>
    `${request.headers.get('X-MASCLI-Scope') ?? api.scope}/${module}`;
  server.use(
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
  );
  return { rows, payloads };
};

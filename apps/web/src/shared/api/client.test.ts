import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { server } from '../../test/server.ts';
import { ApiError, request, requestJson } from './client.ts';

describe('API client', () => {
  it('sends JSON and form bodies same-origin and validates answers', async () => {
    const seen: { type: string | null; body: string; credentials: string }[] = [];
    server.use(
      http.post('/echo', async ({ request: req }) => {
        seen.push({
          type: req.headers.get('content-type'),
          body: await req.text(),
          credentials: req.credentials,
        });
        return HttpResponse.json({ ok: true });
      }),
    );
    const schema = z.object({ ok: z.literal(true) });
    await requestJson('/echo', schema, { method: 'POST', body: { json: { a: 1 } } });
    await requestJson('/echo', schema, { method: 'POST', body: { form: { scope: 'A/B' } } });
    expect(seen.map((s) => [s.type, s.body])).toEqual([
      ['application/json', '{"a":1}'],
      ['application/x-www-form-urlencoded;charset=UTF-8', 'scope=A%2FB'],
    ]);
  });

  it('turns failures into ApiError with a displayable detail', async () => {
    server.use(
      http.get('/plain', () =>
        HttpResponse.json({ detail: 'Proyecto no autorizado' }, { status: 403 }),
      ),
      http.get('/list', () =>
        HttpResponse.json({ detail: [{ loc: ['body'], msg: '<b>x</b>' }] }, { status: 422 }),
      ),
      http.get('/boom', () => new HttpResponse('<html>', { status: 502 })),
    );
    await expect(request('/plain')).rejects.toMatchObject({
      status: 403,
      detail: 'Proyecto no autorizado',
    });
    await expect(request('/list')).rejects.toMatchObject({
      status: 422,
      detail: 'Revise los datos enviados.',
    });
    await expect(request('/boom')).rejects.toBeInstanceOf(ApiError);
    await expect(request('/boom')).rejects.toMatchObject({
      detail: 'El servicio no está disponible. Intente nuevamente.',
    });
  });

  it('rejects answers that break the contract', async () => {
    server.use(http.get('/bad', () => HttpResponse.json({ ok: 'yes' })));
    await expect(requestJson('/bad', z.object({ ok: z.literal(true) }))).rejects.toThrow();
  });

  it('accepts a redirect only when asked to', async () => {
    server.use(
      http.post('/go', () => new HttpResponse(null, { status: 303, headers: { location: '/' } })),
    );
    await expect(request('/go', { method: 'POST', redirect: 'manual' })).resolves.toBeDefined();
  });
});

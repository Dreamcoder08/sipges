import { QueryClient } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { recordsQuery } from '../../features/records/api.ts';
import { server } from '../../test/server.ts';

it('retrieves records beyond the API limit without losing their origin or scope', async () => {
  const rows = Array.from({ length: 501 }, (_, n) => ({
    _id: `DIR-${n}`,
    Nombre: `Contacto de prueba ${n}`,
    ...(n < 500 ? { Dato_Sintetico: true } : {}),
  }));
  const offsets: number[] = [];
  server.use(
    http.get('/api/directorio', ({ request }) => {
      const params = new URL(request.url).searchParams;
      const offset = Number(params.get('offset') ?? 0);
      offsets.push(offset);
      expect(request.headers.get('X-MASCLI-Scope')).toBe('A/B');
      return HttpResponse.json(rows.slice(offset, offset + 500));
    }),
  );
  const result = await new QueryClient().fetchQuery(recordsQuery('directorio', 'A/B', ''));
  expect(result).toHaveLength(501);
  expect(result.at(-1)?.Nombre).toBe('Contacto de prueba 500');
  expect(offsets).toEqual([0, 500]);
});

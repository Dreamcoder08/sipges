import { Hono } from 'hono';
import { GeographyQuery } from '@mascli/contracts';
import type { AppEnv } from '../../../platform/http/env.ts';
import type { GeographyService } from '../application/index.ts';
export const geographyRoutes = ({ geography }: { geography: GeographyService }) =>
  new Hono<AppEnv>()
    .get('/system/geography/catalogue', async (c) => c.json(await geography.catalogue()))
    .post('/system/geography/query', async (c) => {
      if (Number(c.req.header('content-length') ?? 0) > 100_000)
        return c.json({ detail: 'Consulta demasiado extensa' }, 413);
      const stream = c.req.raw.body?.getReader(),
        decoder = new TextDecoder();
      let raw = '',
        size = 0;
      if (stream)
        while (true) {
          const { done, value } = await stream.read();
          if (done) break;
          size += value.byteLength;
          if (size > 100_000) {
            await stream.cancel();
            return c.json({ detail: 'Consulta demasiado extensa' }, 413);
          }
          raw += decoder.decode(value, { stream: true });
        }
      raw += decoder.decode();
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return c.json({ detail: 'JSON inválido' }, 422);
      }
      const parsed = GeographyQuery.safeParse(body);
      if (!parsed.success)
        return c.json(
          { detail: 'Área o capa inválida. Use WGS84 y un máximo de 5° por eje.' },
          422,
        );
      try {
        return c.json(await geography.query(c.get('scope'), parsed.data));
      } catch {
        return c.json(
          {
            detail:
              'No fue posible consultar INGEMMET. Intente nuevamente o consulte el visor oficial.',
          },
          502,
        );
      }
    });

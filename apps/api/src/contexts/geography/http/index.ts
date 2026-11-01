import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { GeographyQuery } from '@sipges/contracts';
import type { AppEnv } from '../../../platform/http/env.ts';
import type { GeographyService } from '../application/index.ts';
/** Install before tenancy consumes/caches JSON, also for requests without Content-Length. */
export const geographyRequestLimit = () =>
  bodyLimit({
    maxSize: 100_000,
    onError: (c) => c.json({ detail: 'Consulta demasiado extensa' }, 413),
  });
export const geographyRoutes = ({ geography }: { geography: GeographyService }) =>
  new Hono<AppEnv>()
    .get('/system/geography/catalogue', async (c) => c.json(await geography.catalogue()))
    .post('/system/geography/query', async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
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

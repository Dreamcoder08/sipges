import { AuthorizedSourceConfigIn, AuthorizedSourceImportIn } from '@sipges/contracts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../../../platform/http/env.ts';
import { parseJson } from '../../../platform/http/validation.ts';
import { formatScope } from '../../tenancy/application/index.ts';
import type { AuthorizedSourcesService } from '../application/authorized-sources.ts';
const BASE = '/system/intelligence/sources';
/** Install before tenancy consumes/caches JSON; the route parser reuses that cache. */
export const sourceRequestLimit = () =>
  bodyLimit({ maxSize: 8192, onError: (c) => c.json({ detail: 'Cuerpo demasiado grande' }, 413) });
export const sourceRoutes = ({ sources }: { sources: AuthorizedSourcesService }) =>
  new Hono<AppEnv>()
    .get(BASE, async (c) => c.json(await sources.catalog(formatScope(c.get('scope')))))
    .get(`${BASE}/defensoria/preview`, async (c) => {
      try {
        return c.json(await sources.preview(c.req.query('query') ?? ''));
      } catch {
        return c.json(
          { detail: 'La fuente oficial no está disponible o devolvió datos inválidos.' },
          502,
        );
      }
    })
    .put(`${BASE}/defensoria/config`, async (c) => {
      const parsed = await parseJson(c, AuthorizedSourceConfigIn);
      if (!parsed.ok) return parsed.response;
      if (parsed.value.enabled && !parsed.value.authorization_note)
        return c.json({ detail: 'Se requiere una nota de autorización explícita' }, 400);
      return c.json(
        await sources.configure(
          formatScope(c.get('scope')),
          parsed.value,
          c.get('identity').username,
        ),
      );
    })
    .post(`${BASE}/defensoria/import`, async (c) => {
      const parsed = await parseJson(c, AuthorizedSourceImportIn);
      if (!parsed.ok) return parsed.response;
      try {
        const result = await sources.importPost(formatScope(c.get('scope')), parsed.value);
        return c.json(result, result.created ? 201 : 200);
      } catch {
        return c.json(
          { detail: 'No se pudo importar la publicación oficial; no se creó una narrativa falsa.' },
          502,
        );
      }
    })
    .post(`${BASE}/defensoria/poll`, async (c) => {
      try {
        return c.json(await sources.poll(formatScope(c.get('scope'))));
      } catch {
        return c.json(
          { detail: 'La consulta de la fuente falló. Consulte el estado del conector.' },
          502,
        );
      }
    });

import { MediaFeedIn } from '@sipges/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../../platform/http/env.ts';
import { parseJson } from '../../../platform/http/validation.ts';
import { formatScope } from '../../tenancy/application/index.ts';
import { type MediaMonitorService, feedErrorMessage } from '../application/media-monitor.ts';

const BASE = '/system/v4/media';

const PreviewIn = z.object({
  url: z.string().trim().min(1).max(500),
  keywords: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
});

const feedId = (value: string) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : null;
};

/** Media monitoring by public RSS/Atom feeds (docs/adr/0021). Writes are admin-only. */
export const mediaRoutes = ({ media }: { media: MediaMonitorService }) =>
  new Hono<AppEnv>()
    .get(BASE, async (c) => c.json(await media.state(formatScope(c.get('scope')))))
    .post(`${BASE}/feeds`, async (c) => {
      const body = await parseJson(c, MediaFeedIn);
      if (!body.ok) return body.response;
      const saved = await media.create(
        formatScope(c.get('scope')),
        body.value,
        c.get('identity').username,
      );
      return 'detail' in saved ? c.json(saved, 422) : c.json(saved, 201);
    })
    .put(`${BASE}/feeds/:id`, async (c) => {
      const id = feedId(c.req.param('id'));
      if (!id) return c.json({ detail: 'Fuente no encontrada' }, 404);
      const body = await parseJson(c, MediaFeedIn);
      if (!body.ok) return body.response;
      const saved = await media.update(
        formatScope(c.get('scope')),
        id,
        body.value,
        c.get('identity').username,
      );
      if (!saved) return c.json({ detail: 'Fuente no encontrada' }, 404);
      return 'detail' in saved ? c.json(saved, 422) : c.json(saved);
    })
    .delete(`${BASE}/feeds/:id`, async (c) => {
      const id = feedId(c.req.param('id'));
      const removed =
        id !== null &&
        (await media.remove(formatScope(c.get('scope')), id, c.get('identity').username));
      return removed ? c.json({ ok: true }) : c.json({ detail: 'Fuente no encontrada' }, 404);
    })
    .post(`${BASE}/preview`, async (c) => {
      const body = await parseJson(c, PreviewIn);
      if (!body.ok) return body.response;
      try {
        const preview = await media.preview(body.value.url, body.value.keywords);
        return 'detail' in preview ? c.json(preview, 422) : c.json(preview);
      } catch (error) {
        return c.json({ detail: feedErrorMessage(error) }, 502);
      }
    })
    .post(`${BASE}/poll`, async (c) =>
      c.json(await media.poll(formatScope(c.get('scope')), { force: true })),
    );

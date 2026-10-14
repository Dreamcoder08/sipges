import { ApiKeyIn, type ApiKeyCreated, type ApiKeyOut } from '@mascli/contracts';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { AppEnv } from '../../../platform/http/env.ts';
import { isoSeconds } from '../../../platform/http/time.ts';
import { parseJson } from '../../../platform/http/validation.ts';
import { formatScope } from '../../tenancy/application/index.ts';
import type { ApiKeyService, StoredKey } from '../application/index.ts';

const tenantOf = (c: Context<AppEnv>) => formatScope(c.get('scope'));

const keyOut = (key: StoredKey): ApiKeyOut => ({
  id: key.id,
  name: key.name,
  prefix: key.prefix,
  access: key.access,
  clearance: key.clearance,
  created_by: key.createdBy,
  created_at: isoSeconds(key.createdAt),
  last_used_at: key.lastUsedAt ? isoSeconds(key.lastUsedAt) : null,
  revoked_at: key.revokedAt ? isoSeconds(key.revokedAt) : null,
});

/** Administrators manage the active project's API keys (access policy: /system/integrations). */
export const apiKeyRoutes = (keys: ApiKeyService) =>
  new Hono<AppEnv>()
    .get('/system/integrations/api-keys', async (c) =>
      c.json((await keys.list(tenantOf(c))).map(keyOut)),
    )
    .post('/system/integrations/api-keys', async (c) => {
      const body = await parseJson(c, ApiKeyIn);
      if (!body.ok) return body.response;
      const created = await keys.create(tenantOf(c), body.value, c.get('identity').username);
      if (!created.ok) return c.json({ detail: 'Ya existe una clave con ese nombre' }, 409);
      return c.json({
        ok: true,
        id: created.value.id,
        token: created.value.token,
      } satisfies ApiKeyCreated);
    })
    .delete('/system/integrations/api-keys/:id', async (c) => {
      const raw = c.req.param('id');
      const id = /^\d{1,9}$/.test(raw) ? Number(raw) : null;
      const revoked = id !== null && (await keys.revoke(tenantOf(c), id));
      return revoked ? c.json({ ok: true }) : c.json({ detail: 'Clave no encontrada' }, 404);
    });

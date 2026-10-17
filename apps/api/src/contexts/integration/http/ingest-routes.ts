import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../../../platform/http/env.ts';
import {
  type ApiKeyService,
  type IngestService,
  formPayload,
  idempotencyKey,
} from '../application/index.ts';
import { authenticateKey } from './machine-auth.ts';

export const INGEST_PATH = '/hooks/ingest/:module';

/** Enough for 50 records of a few kilobytes each; larger calls are refused unread. */
const MAX_BODY_BYTES = 512 * 1024;

const isForm = (type: string) =>
  type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data');

/**
 * Inbound webhook for automation tools and forms (docs/adr/0014 §6): a write API key creates
 * records in its project. JSON bodies may hold one record or many; form posts hold one.
 */
export const ingestRoutes = (deps: { keys: ApiKeyService; ingest: IngestService }) =>
  new Hono<AppEnv>().post(
    INGEST_PATH,
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ detail: 'Cuerpo demasiado grande' }, 413),
    }),
    async (c) => {
      const auth = await authenticateKey(c, deps.keys, { write: true });
      if (!auth.ok) return auth.response;
      const key = idempotencyKey(c.req.header('idempotency-key') ?? c.req.header('webhook-id'));
      if (key === 'invalid') return c.json({ detail: 'Idempotency-Key no válida' }, 400);

      const type = (c.req.header('content-type') ?? '').toLowerCase();
      let body: unknown;
      try {
        body = isForm(type)
          ? formPayload(await c.req.parseBody())
          : type.startsWith('application/json')
            ? await c.req.json()
            : undefined;
      } catch {
        return c.json({ detail: 'Cuerpo no válido' }, 400);
      }
      if (body === undefined) {
        return c.json({ detail: 'Usa application/json o un formulario' }, 415);
      }

      const outcome = await deps.ingest.ingest({
        principal: auth.principal,
        projectId: auth.projectId,
        slug: c.req.param('module'),
        body,
        idempotencyKey: key,
      });
      if (outcome.replayed) c.header('Idempotent-Replayed', 'true');
      if (!outcome.replayed && (outcome.status === 201 || outcome.status === 207)) {
        c.set('automationTenant', auth.principal.tenantId);
      }
      return c.json(outcome.body, outcome.status as 201);
    },
  );

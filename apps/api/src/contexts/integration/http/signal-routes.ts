import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AppEnv } from '../../../platform/http/env.ts';
import type { ApiKeyService, IngestService } from '../application/index.ts';
import { idempotencyKey } from '../application/index.ts';
import { authenticateKey } from './machine-auth.ts';
const cleanText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !value.includes('\0'));
const reference = z
  .string()
  .url()
  .max(2000)
  .refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  });
const SignalIn = z.object({
  source_name: cleanText(100),
  source_url: reference,
  external_id: cleanText(200),
  text: cleanText(20000),
  observed_at: z.iso.datetime({ offset: true }),
  territory: cleanText(200).optional(),
});
/** Structured references are never fetched. API-key scope and existing receipt transactions own ingestion. */
export const signalRoutes = (deps: { keys: ApiKeyService; ingest: IngestService }) =>
  new Hono<AppEnv>().post(
    '/hooks/signals',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ detail: 'Cuerpo demasiado grande' }, 413),
    }),
    async (c) => {
      const auth = await authenticateKey(c, deps.keys, { write: true });
      if (!auth.ok) return auth.response;
      const parsed = SignalIn.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ detail: 'Referencia estructurada no válida' }, 422);
      const input = parsed.data;
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            input.source_name,
            input.source_url,
            input.external_id,
            input.text,
            new Date(input.observed_at).toISOString(),
            input.territory ?? '',
          ]),
        )
        .digest('hex');
      const key = idempotencyKey(c.req.header('idempotency-key')) ?? `signal-${fingerprint}`;
      if (key === 'invalid') return c.json({ detail: 'Idempotency-Key no válida' }, 400);
      const outcome = await deps.ingest.ingest({
        principal: auth.principal,
        projectId: auth.projectId,
        slug: 'narrativas',
        idempotencyKey: key,
        body: {
          Descripcion: input.text,
          URL_Publicacion: input.source_url,
          'Plataforma/Fuente': input.source_name,
          Tipo_Fuente: 'Publicación digital',
          Fuente_Integracion: 'structured-hook',
          Fuente_ID_Externo: input.external_id,
          Fuente_Huella_SHA256: fingerprint,
          Fuente_Observada_En: input.observed_at,
          ...(input.territory ? { Territorio: input.territory } : {}),
        },
      });
      if (outcome.replayed) c.header('Idempotent-Replayed', 'true');
      if (!outcome.replayed && (outcome.status === 201 || outcome.status === 207))
        c.set('automationTenant', auth.principal.tenantId);
      return c.json(outcome.body, outcome.status as 201);
    },
  );

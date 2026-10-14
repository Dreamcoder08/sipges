import {
  type RecordsService,
  moduleForSlug,
  validatePayload,
} from '../../records/application/index.ts';
import type { ApiPrincipal } from '../domain/api-key.ts';
import { payloadProject } from '../domain/api-key.ts';
import { ingestPayloads } from '../domain/ingest.ts';
import type { Clock, IngestReceipts, IngestResponse } from './ports.ts';

export type IngestRequest = {
  readonly principal: ApiPrincipal;
  /** The key's project id, which a payload may not contradict. */
  readonly projectId: string;
  readonly slug: string;
  readonly body: unknown;
  readonly idempotencyKey: string | null;
};

export type IngestOutcome = IngestResponse & { readonly replayed: boolean };

const reply = (status: number, body: Record<string, unknown>): IngestResponse => ({
  status,
  body,
});

/**
 * Inbound webhooks (docs/adr/0014 §6): each record is created like one from the app, with
 * its own CREATE audit row, so automation rules react to it. Every payload is checked before
 * the first one is written. With an idempotency key a retried call replays the first answer.
 */
export const createIngestService = (deps: {
  records: RecordsService;
  receipts: IngestReceipts;
  clock: Clock;
}) => {
  const { records, receipts, clock } = deps;

  const create = async (request: IngestRequest): Promise<IngestResponse> => {
    const module = moduleForSlug(request.slug);
    if (!module) return reply(404, { detail: 'Módulo no válido' });
    const parsed = ingestPayloads(request.body);
    if (!parsed.ok)
      return reply(422, { detail: parsed.problem.message, index: parsed.problem.index });
    for (const [index, payload] of parsed.payloads.entries()) {
      const project = payloadProject(payload);
      if (project && project !== request.projectId) {
        return reply(403, { detail: 'No se permite escribir en otro proyecto', index });
      }
      const problem = validatePayload(module, payload);
      if (problem) return reply(422, { detail: problem.message, index });
    }
    const ids: string[] = [];
    for (const payload of parsed.payloads) {
      const created = await records.create(request.principal.tenantId, module, payload);
      if (!created.ok) {
        return reply(ids.length ? 207 : 500, {
          detail: 'No se pudo asignar un id',
          module: request.slug,
          ids,
        });
      }
      ids.push(created.value);
    }
    return reply(201, { ok: true, module: request.slug, ids });
  };

  return {
    async ingest(request: IngestRequest): Promise<IngestOutcome> {
      const key = request.idempotencyKey;
      if (!key) return { ...(await create(request)), replayed: false };
      const { tenantId, keyId } = request.principal;
      const claim = await receipts.claim(tenantId, keyId, key, clock.now());
      if (claim.kind === 'stored') return { ...claim.response, replayed: true };
      if (claim.kind === 'in_progress') {
        return {
          ...reply(409, { detail: 'Una llamada con la misma Idempotency-Key está en curso' }),
          replayed: false,
        };
      }
      try {
        const response = await create(request);
        // Only answers that wrote something are kept; a rejected call may be corrected and retried.
        if (response.status === 201 || response.status === 207) {
          await receipts.complete(tenantId, keyId, key, response);
        } else {
          await receipts.release(tenantId, keyId, key);
        }
        return { ...response, replayed: false };
      } catch (error) {
        await receipts.release(tenantId, keyId, key);
        throw error;
      }
    },
  };
};

export type IngestService = ReturnType<typeof createIngestService>;

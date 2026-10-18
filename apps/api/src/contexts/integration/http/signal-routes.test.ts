import { Hono } from 'hono';
import { expect, it } from 'vitest';
import type { ApiKeyService, IngestService } from '../application/index.ts';
import { signalRoutes } from './signal-routes.ts';
const body = {
  source_name: 'Synthetic publisher',
  source_url: 'https://example.test/reference',
  external_id: 'publication-1',
  text: 'Convocatoria pública documentada',
  observed_at: '2026-10-17T12:00:00Z',
};
it('maps authenticated references without fetching and deduplicates body retries', async () => {
  const inputs: unknown[] = [];
  const app = new Hono().route(
    '/',
    signalRoutes({
      keys: {
        authenticate: async () => ({
          tenantId: 'ACME/P1',
          keyId: 1,
          access: 'write',
          clearance: 'full',
          name: 'Synthetic',
        }),
      } as unknown as ApiKeyService,
      ingest: {
        ingest: async (input) => {
          inputs.push(input);
          return { status: 201, body: { ok: true }, replayed: false };
        },
      } as IngestService,
    }),
  );
  const call = () =>
    app.request('/hooks/signals', {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await call()).status).toBe(201);
  expect((await call()).status).toBe(201);
  const [first, second] = inputs as {
    body: Record<string, unknown>;
    idempotencyKey: string;
    principal: { tenantId: string };
  }[];
  if (!first || !second) throw new Error('Expected both ingress calls');
  expect(first.body.URL_Publicacion).toBe(body.source_url);
  expect(first.body.Descripcion).toBe(body.text);
  expect(first.body.Territorio).toBeUndefined();
  expect(first.principal.tenantId).toBe('ACME/P1');
  expect(first.idempotencyKey).toBe(second.idempotencyKey);
});
it('rejects read-only keys before ingestion', async () => {
  let ingested = false;
  const app = new Hono().route(
    '/',
    signalRoutes({
      keys: {
        authenticate: async () => ({
          tenantId: 'ACME/P1',
          keyId: 1,
          access: 'read',
          clearance: 'limited',
          name: 'Synthetic',
        }),
      } as unknown as ApiKeyService,
      ingest: {
        ingest: async () => {
          ingested = true;
          return {} as never;
        },
      } as IngestService,
    }),
  );
  expect(
    (
      await app.request('/hooks/signals', {
        method: 'POST',
        headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(403);
  expect(ingested).toBe(false);
});
it('rejects invalid timestamps, credential URLs and oversized text', async () => {
  let ingested = false;
  const app = new Hono().route(
    '/',
    signalRoutes({
      keys: {
        authenticate: async () => ({
          tenantId: 'ACME/P1',
          keyId: 1,
          access: 'write',
          clearance: 'full',
          name: 'Synthetic',
        }),
      } as unknown as ApiKeyService,
      ingest: {
        ingest: async () => {
          ingested = true;
          return {} as never;
        },
      } as IngestService,
    }),
  );
  for (const invalid of [
    { ...body, observed_at: 'yesterday' },
    { ...body, source_url: 'https://user:password@example.test/item' },
    { ...body, text: 'x'.repeat(20001) },
  ]) {
    const response = await app.request('/hooks/signals', {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify(invalid),
    });
    expect(response.status).toBe(422);
  }
  expect(ingested).toBe(false);
});

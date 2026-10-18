import { describe, expect, it } from 'vitest';
import {
  createAuthorizedSourcesService,
  emptySourceState,
  type SourceSettingsStore,
} from './authorized-sources.ts';
const post = {
  id: 17,
  url: 'https://www.defensoria.gob.pe/example',
  title: 'Aviso oficial',
  excerpt: 'Evidencia pública',
  published_at: '2026-10-17T10:00:00.000Z',
};
describe('authorized source ingress', () => {
  it('imports verified metadata with deterministic provenance and no invented territory', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const service = createAuthorizedSourcesService({
      gateway: { preview: async () => [post], get: async () => post },
      settings: {} as SourceSettingsStore,
      importer: {
        createOnce: async (_tenant, id, payload) => {
          const created = !rows.has(id);
          if (created) rows.set(id, payload);
          return { id, created };
        },
      },
    });
    expect((await service.importPost('tenant', { post_id: 17 })).created).toBe(true);
    expect((await service.importPost('tenant', { post_id: 17 })).created).toBe(false);
    const payload = [...rows.values()][0];
    if (!payload) throw new Error('Expected imported narrative');
    expect(payload.URL_Publicacion).toBe(post.url);
    expect(payload.Fuente_Integracion).toBe('defensoria');
    expect(payload.Fuente_Huella_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.Territorio).toBeUndefined();
  });
  it('requires explicit authorization to enable', async () => {
    const service = createAuthorizedSourcesService({
      gateway: {} as never,
      settings: {} as SourceSettingsStore,
      importer: {} as never,
    });
    await expect(
      service.configure(
        'tenant',
        { enabled: true, query: '', territory: '', authorization_note: '' },
        'operator',
      ),
    ).rejects.toThrow('autorización');
  });
});
it('does not import after configuration changes during fetching', async () => {
  let reads = 0;
  let imported = 0;
  const initial = { ...emptySourceState(), enabled: true, revision: 1 };
  const service = createAuthorizedSourcesService({
    gateway: { preview: async () => [post], get: async () => post },
    settings: {
      get: async () => ({ ...initial, revision: ++reads }),
      save: async () => initial,
      claimPoll: async () => true,
      finishPoll: async () => undefined,
      activeTenants: async () => [],
    },
    importer: {
      createOnce: async () => {
        imported++;
        return { id: 'test', created: true };
      },
    },
  });
  expect(await service.poll('tenant')).toEqual({ skipped: false, imported: 0, duplicates: 0 });
  expect(imported).toBe(0);
});
it('records sanitized failure and throws instead of empty success', async () => {
  let recorded = '';
  const service = createAuthorizedSourcesService({
    gateway: {
      preview: async () => {
        throw new Error('private provider diagnostic');
      },
      get: async () => post,
    },
    settings: {
      get: async () => ({ ...emptySourceState(), enabled: true, revision: 1 }),
      save: async () => emptySourceState(),
      claimPoll: async () => true,
      finishPoll: async (_tenant, _at, outcome) => {
        recorded = outcome.error;
      },
      activeTenants: async () => [],
    },
    importer: {} as never,
  });
  await expect(service.poll('tenant')).rejects.toThrow('source_poll_failed');
  expect(recorded).toBe('source_poll_failed');
});
it('does not fetch a throttled source', async () => {
  let fetched = false;
  const service = createAuthorizedSourcesService({
    gateway: {
      preview: async () => {
        fetched = true;
        return [];
      },
      get: async () => post,
    },
    settings: {
      get: async () => ({ ...emptySourceState(), enabled: true }),
      claimPoll: async () => false,
      save: async () => emptySourceState(),
      finishPoll: async () => undefined,
      activeTenants: async () => [],
    },
    importer: {} as never,
  });
  expect((await service.poll('tenant')).skipped).toBe(true);
  expect(fetched).toBe(false);
});

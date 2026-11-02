import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../../src/contexts/intelligence/application/index.ts';
import { createTestApp } from '../support/test-app.ts';

const counting = (vector: () => Promise<number[]>) => {
  const calls: string[] = [];
  const embeddings: EmbeddingProvider = {
    model: 'fake-embed',
    egress: 'local',
    embed: async (text) => {
      calls.push(text);
      return vector();
    },
  };
  return { embeddings, calls };
};

const status = async (t: Awaited<ReturnType<typeof createTestApp>>, cookie: string) => {
  const res = await t.request('/system/intelligence/embedder', { headers: { cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
};

describe('GET /system/intelligence/embedder', () => {
  it('reports an unreachable embedder so the UI can fall back to keyword search', async () => {
    const t = await createTestApp();
    const { cookie } = await t.login('admin', 'admin-password-123');
    expect(await status(t, cookie)).toEqual({
      configured: false,
      available: false,
      reason: 'unreachable',
      model: 'offline-test-model',
      egress: 'local',
      semantic_search: false,
    });
  });

  it('reports a reachable embedder and caches the probe briefly', async () => {
    const { embeddings, calls } = counting(async () => [1, 0, 0, 0, 0, 0, 0, 0.1]);
    const t = await createTestApp(
      { SIPGES_OLLAMA_URL: 'http://127.0.0.1:11434', SIPGES_SEMANTIC_SEARCH: '1' },
      { embeddings },
    );
    const { cookie } = await t.login('admin', 'admin-password-123');
    expect(await status(t, cookie)).toMatchObject({
      configured: true,
      available: true,
      reason: null,
      semantic_search: true,
    });
    await status(t, cookie);
    expect(calls).toHaveLength(1);
    t.clock.advance(61);
    await status(t, cookie);
    expect(calls).toHaveLength(2);
  });

  it('re-probes after the cache expires instead of remembering a failure', async () => {
    let up = false;
    const { embeddings } = counting(async () => {
      if (!up) throw new Error('offline');
      return [1, 0, 0, 0, 0, 0, 0, 0.1];
    });
    const t = await createTestApp({}, { embeddings });
    const { cookie } = await t.login('admin', 'admin-password-123');
    expect(await status(t, cookie)).toMatchObject({ available: false, reason: 'unreachable' });
    up = true;
    t.clock.advance(61);
    expect(await status(t, cookie)).toMatchObject({ available: true, reason: null });
  });
});

describe('embedder probe across requests', () => {
  it('does not make a later request wait on a probe that never finishes', async () => {
    // A probe started by a cancelled request never settles on Workers; the next request probes itself.
    let calls = 0;
    const embeddings: EmbeddingProvider = {
      model: 'fake-embed',
      egress: 'local',
      embed: () => {
        calls += 1;
        return calls === 1 ? new Promise<number[]>(() => {}) : Promise.resolve([1, 0, 0]);
      },
    };
    const t = await createTestApp(
      { SIPGES_OLLAMA_URL: 'http://127.0.0.1:11434', SIPGES_SEMANTIC_SEARCH: '1' },
      { embeddings },
    );
    const { cookie } = await t.login('admin', 'admin-password-123');
    void t.request('/system/intelligence/embedder', { headers: { cookie } });
    const started = Date.now();
    expect(await status(t, cookie)).toMatchObject({ available: true, reason: null });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

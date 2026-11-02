import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../../src/contexts/intelligence/application/index.ts';
import { createOllamaEmbeddings } from '../../src/contexts/intelligence/infrastructure/index.ts';
import { PSEUDONYM, leaks, setupPrivacy } from './support.ts';

const provider = (egress: 'local' | 'external') => {
  const sent: string[] = [];
  const embeddings: EmbeddingProvider = {
    model: 'toy',
    egress,
    embed: async (text) => {
      sent.push(text);
      return [1, 0, 0, 0, 0, 0, 0, 0.1];
    },
  };
  return { embeddings, sent };
};

const search = async (t: Awaited<ReturnType<typeof setupPrivacy>>, q: string) =>
  (await t.call('GET', `/system/search?q=${encodeURIComponent(q)}`)).body.hits as unknown[];

describe('embeddings to an external URL', () => {
  it('are refused while the switch is off, and search falls back to lexical', async () => {
    const { embeddings, sent } = provider('external');
    const t = await setupPrivacy({ env: { SIPGES_SEMANTIC_SEARCH: '1' }, embeddings });
    await t.seed();
    expect((await search(t, 'asamblea')).length).toBeGreaterThan(0);
    expect(sent).toEqual([]);
    expect(await t.egressRows()).toEqual([]);
  });

  it('send only allowed, pseudonymised text once the switch is on, and are logged', async () => {
    const { embeddings, sent } = provider('external');
    const t = await setupPrivacy({ env: { SIPGES_SEMANTIC_SEARCH: '1' }, embeddings });
    await t.seed();
    await t.setSwitch(true);
    await search(t, `asamblea ${'Marcos Villanueva Prado'}`);
    expect(sent.length).toBeGreaterThan(1);
    for (const text of sent) {
      expect(leaks(text)).toEqual([]);
      expect(text).not.toContain('Observaciones');
      expect(text).not.toContain('Posicion_Proyecto');
    }
    expect(sent.join('\n')).toMatch(PSEUDONYM);
    const rows = await t.egressRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.detail.includes('embeddings'))).toBe(true);
    expect(leaks(JSON.stringify(rows))).toEqual([]);
  });

  it('a local model is not egress: no switch, no pseudonyms, no log', async () => {
    const { embeddings, sent } = provider('local');
    const t = await setupPrivacy({ env: { SIPGES_SEMANTIC_SEARCH: '1' }, embeddings });
    await t.seed();
    await search(t, 'asamblea');
    expect(sent.some((text) => text.includes('Marcos Villanueva Prado'))).toBe(true);
    expect(await t.egressRows()).toEqual([]);
  });

  it('semantic text analysis follows the same rules', async () => {
    const off = provider('external');
    const t = await setupPrivacy({ embeddings: off.embeddings });
    const body = {
      text: 'Escribió Marcos Villanueva Prado (marcos.villanueva@example.org) pidiendo agua limpia.',
      mode: 'semantic',
    };
    const refused = await t.call('POST', '/system/intelligence/semantic-analyze', body);
    expect(refused.status).toBe(503);
    expect(off.sent).toEqual([]);
    await t.seed();
    await t.setSwitch(true);
    const ok = await t.call('POST', '/system/intelligence/semantic-analyze', body);
    expect(ok.status).toBe(200);
    expect(off.sent.some((text) => text.includes('Escribió'))).toBe(true);
    for (const text of off.sent) expect(leaks(text)).toEqual([]);
  });
});

describe('embedder status with an external URL', () => {
  it('is unavailable without probing while the switch is off', async () => {
    const { embeddings, sent } = provider('external');
    const t = await setupPrivacy({ embeddings });
    const off = await t.call('GET', '/system/intelligence/embedder');
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({
      available: false,
      reason: 'external_ai_disabled',
      egress: 'external',
    });
    expect(sent).toEqual([]);
    await t.setSwitch(true);
    expect((await t.call('GET', '/system/intelligence/embedder')).body).toMatchObject({
      available: true,
      reason: null,
    });
    // The probe embeds a constant written in the code: no tenant data, no access-log row.
    expect(await t.egressRows()).toEqual([]);
  });
});

describe('Ollama adapter', () => {
  const adapter = (baseUrl: string) => {
    const requests: string[] = [];
    const fetchFake = (async (url: URL | Request | string) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ embeddings: [[1, 2, 3, 4, 5, 6, 7, 8]] }));
    }) as typeof fetch;
    return {
      provider: createOllamaEmbeddings({ baseUrl, model: 'm', fetch: fetchFake }),
      requests,
    };
  };

  it.each([
    'http://127.0.0.1:11434',
    'http://localhost:11434',
    'http://[::1]:11434',
    'http://127.0.0.5:11434',
  ])('treats %s as local', (url) => {
    expect(adapter(url).provider.egress).toBe('local');
  });

  it.each(['https://ollama.example.org', 'http://192.168.1.20:11434', 'http://10.0.0.2:11434'])(
    'treats %s as external',
    (url) => {
      expect(adapter(url).provider.egress).toBe('external');
    },
  );
});

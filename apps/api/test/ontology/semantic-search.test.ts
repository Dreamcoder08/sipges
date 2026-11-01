import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../../src/contexts/intelligence/application/index.ts';
import { cosine, fuseRankings } from '../../src/contexts/ontology/domain/semantic.ts';
import { createTestApp } from '../support/test-app.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** A toy model with three concepts, enough to tell meaning from shared words. */
const CONCEPTS = [/agua|hídric|riego/i, /carretera|vía|bloqueo/i, /minería|mina/i];
const conceptEmbeddings = (log: string[] = []): EmbeddingProvider => ({
  model: 'toy-concepts',
  embed: async (text) => {
    log.push(text);
    return [...CONCEPTS.map((c) => (c.test(text) ? 1 : 0)), 0.01, 0, 0, 0, 0];
  },
});

const setup = async (embeddings: EmbeddingProvider, semantic = '1') => {
  const t = await createTestApp({ SIPGES_SEMANTIC_SEARCH: semantic }, { embeddings });
  const admin = await t.login('admin', 'admin-password-123');
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await t.request(path, {
      method,
      headers: {
        cookie: admin.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  await call('POST', '/api/eventos', {
    payload: { ID_Evento: 'EV-1', Descripcion_Hecho: 'Conflicto hídrico en el valle sintético' },
  });
  await call('POST', '/api/eventos', {
    payload: { ID_Evento: 'EV-2', Descripcion_Hecho: 'Bloqueo de carretera sintético' },
  });
  await call('POST', '/api/eventos', {
    payload: { ID_Evento: 'EV-3', Descripcion_Hecho: 'Informe reservado sobre riego' },
  });
  await call('PUT', '/system/marking', { module: 'eventos', id: 'EV-3', marking: 'restringido' });
  const search = async (q: string) =>
    ((await call('GET', `/system/search?q=${encodeURIComponent(q)}`)).body.hits as Json[]).map(
      (h) => `${h.id}${h.semantic ? '~' : ''}`,
    );
  return { ...t, call, search };
};

describe('hybrid search', () => {
  it('finds records by meaning and fuses them with lexical hits', async () => {
    const sent: string[] = [];
    const t = await setup(conceptEmbeddings(sent));
    // No record says "agua", but EV-1 is about water; EV-3 is restricted and never embedded.
    expect(await t.search('agua')).toEqual(['EV-1~']);
    expect(sent.some((text) => text.includes('Informe reservado'))).toBe(false);
    expect(await t.search('bloqueo')).toEqual(['EV-2~']);
    // A changed record is embedded again on the next search.
    await t.call('PUT', '/api/eventos/EV-2', {
      payload: { ID_Evento: 'EV-2', Descripcion_Hecho: 'Paro por la mina sintética' },
    });
    expect(await t.search('minería')).toEqual(['EV-2~']);
  });

  it('falls back to lexical search when the model is down or semantic search is off', async () => {
    const down = await setup({
      model: 'down',
      embed: () => Promise.reject(new Error('offline')),
    });
    expect(await down.search('bloqueo')).toEqual(['EV-2']);
    expect(await down.search('agua')).toEqual([]);
    const off = await setup(conceptEmbeddings(), '0');
    expect(await off.search('agua')).toEqual([]);
  });
});

describe('ranking helpers', () => {
  it('fuses rankings by reciprocal rank and measures cosine similarity', () => {
    expect(
      fuseRankings(
        [
          ['a', 'b', 'c'],
          ['c', 'd'],
        ],
        3,
      ),
    ).toEqual(['c', 'a', 'b']);
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1], [1, 0])).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { EMBEDDER_DOWN, startEmbedderDouble, vectorOf } from './embedder-double.ts';

const embed = async (url: string, input: string) =>
  fetch(`${url}/api/embed`, { method: 'POST', body: JSON.stringify({ model: 'm', input }) });

describe('embedder double', () => {
  it('gives the same vector to the same text and a usable length', () => {
    expect(vectorOf('agua')).toEqual(vectorOf('agua'));
    expect(vectorOf('agua')).not.toEqual(vectorOf('tierra'));
    expect(vectorOf('')).toHaveLength(16);
  });

  it('answers as Ollama does, and fails on request', async () => {
    const double = await startEmbedderDouble();
    try {
      const ok = await embed(double.url, 'agua');
      expect(await ok.json()).toEqual({ embeddings: [vectorOf('agua')] });
      expect((await embed(double.url, `x ${EMBEDDER_DOWN}`)).status).toBe(500);
    } finally {
      await double.stop();
    }
  });
});

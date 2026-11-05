import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMBEDDER_DOWN, startEmbedderDouble, vectorOf } from './embedder-double.ts';

const embed = async (url: string, input: string) =>
  fetch(`${url}/api/embed`, { method: 'POST', body: JSON.stringify({ model: 'm', input }) });

test('the double gives the same vector to the same text and a usable length', () => {
  assert.deepEqual(vectorOf('agua'), vectorOf('agua'));
  assert.notDeepEqual(vectorOf('agua'), vectorOf('tierra'));
  assert.equal(vectorOf('').length, 16);
  assert.deepEqual(vectorOf('agua TSAPI'), vectorOf('agua GOAPI'));
  assert.notDeepEqual(vectorOf('Fecha: 1\nTipo: 2'), vectorOf('Tipo: 2\nFecha: 1'));
});

test('the double answers as Ollama does, and fails on request', async () => {
  const double = await startEmbedderDouble();
  try {
    const ok = await embed(double.url, 'agua');
    assert.deepEqual(await ok.json(), { embeddings: [vectorOf('agua')] });
    assert.equal((await embed(double.url, `x ${EMBEDDER_DOWN}`)).status, 500);
  } finally {
    await double.stop();
  }
});

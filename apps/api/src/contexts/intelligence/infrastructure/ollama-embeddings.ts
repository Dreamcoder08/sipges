import type { EmbeddingProvider } from '../application/index.ts';

const TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 1_500_000;
const MAX_INPUT_CODE_POINTS = 12_000;

/**
 * Embeddings from an Ollama server (`POST /api/embed`), local by default like app.py. Only the
 * configured base URL is ever contacted; request text never selects a host.
 */
export const createOllamaEmbeddings = (config: {
  baseUrl: string;
  model: string;
  fetch?: typeof fetch;
}): EmbeddingProvider => {
  const doFetch = config.fetch ?? fetch;
  const endpoint = new URL('/api/embed', config.baseUrl);
  return {
    model: config.model,
    async embed(text) {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          input: Array.from(text).slice(0, MAX_INPUT_CODE_POINTS).join(''),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`Embedding service answered ${res.status}`);
      const body = await res.arrayBuffer();
      if (body.byteLength > MAX_RESPONSE_BYTES) throw new Error('Embedding response too large');
      const parsed = JSON.parse(new TextDecoder().decode(body)) as { embeddings?: unknown };
      const vector = Array.isArray(parsed.embeddings) ? parsed.embeddings[0] : undefined;
      if (
        !Array.isArray(vector) ||
        vector.length < 8 ||
        !vector.every((v) => typeof v === 'number')
      )
        throw new Error('Embedding model returned no valid vector');
      return vector as number[];
    },
  };
};

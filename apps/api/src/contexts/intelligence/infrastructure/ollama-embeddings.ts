import type { SanitisedPayload } from '../../privacy/application/index.ts';
import type { EmbeddingProvider } from '../application/index.ts';
import { outboundTraceHeaders } from '../../../platform/observability/trace.ts';

const TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 1_500_000;
const MAX_INPUT_CODE_POINTS = 12_000;

/** Only a server on this machine is not egress: the text never crosses a network. */
const isLoopback = (url: URL) =>
  url.hostname === 'localhost' ||
  url.hostname === '[::1]' ||
  /^127(\.\d{1,3}){3}$/.test(url.hostname);

/**
 * Embeddings from an Ollama server (`POST /api/embed`), local by default like app.py. Only the
 * configured base URL is ever contacted; request text never selects a host. A base URL that is
 * not loopback is external AI: its callers clear every text with the egress guard first.
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
    egress: isLoopback(endpoint) ? 'local' : 'external',
    async embed(text: SanitisedPayload<string>) {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...outboundTraceHeaders() },
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

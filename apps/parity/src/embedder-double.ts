import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Running } from './servers.ts';

const DIMENSIONS = 16;

/** A text containing this makes the double fail, so both APIs take their fallback path. */
export const EMBEDDER_DOWN = 'PARITY-EMBEDDER-DOWN';

/**
 * Counts each code point in one of 16 buckets, weighted by its position, so the same text always
 * gets the same vector and a text in another order gets another one. The tokens of a `perApi` case
 * are left out, so both APIs' copies of a text rank the same.
 */
export const vectorOf = (text: string) => {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  let position = 0;
  for (const char of text.replace(/TSAPI|GOAPI/g, '')) {
    const bucket = (char.codePointAt(0) ?? 0) % DIMENSIONS;
    vector[bucket] = (vector[bucket] ?? 0) + 1 + (position++ % 3);
  }
  return vector;
};

/** A briefing holding this makes the double's narrator refuse to cite, for the failure path. */
export const NARRATOR_DOWN = 'PARITY-NARRATOR-DOWN';

type Narration = { readonly messages: readonly { readonly content: string }[] };

/** The Messages API's answer: prose citing the first source the briefing names. */
const narrationOf = (body: Narration) => {
  const content = body.messages[0]?.content ?? '';
  const mark = /\[\d+\]/.exec(content)?.[0] ?? '';
  return {
    id: 'msg_parity',
    type: 'message',
    role: 'assistant',
    model: 'claude-parity',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: 'text', text: ` Resumen sintético ${mark}. ` }],
  };
};

/**
 * A synthetic Ollama and Messages API on loopback: parity never contacts a real provider.
 * `narrated` holds every request body the Messages API received, as it arrived.
 */
export const startEmbedderDouble = async (): Promise<Running & { narrated: string[] }> => {
  const narrated: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if ((request.url ?? '').startsWith('/v1/messages')) {
        // The two SDKs name themselves, so each body is attributed to the API that sent it.
        narrated.push(
          `${/go/i.test(request.headers['user-agent'] ?? '') ? 'go' : 'ts'}\u0000${raw}`,
        );
        const down = raw.includes(NARRATOR_DOWN);
        response.writeHead(down ? 400 : 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(down ? { type: 'error' } : narrationOf(JSON.parse(raw))));
        return;
      }
      const { input } = JSON.parse(raw) as { input: string };
      const down = input.includes(EMBEDDER_DOWN);
      response.writeHead(down ? 500 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(down ? { error: 'down' } : { embeddings: [vectorOf(input)] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    narrated,
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
};

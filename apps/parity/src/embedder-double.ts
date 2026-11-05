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

/** A synthetic Ollama on loopback: parity never contacts a real embedding provider. */
export const startEmbedderDouble = async (): Promise<Running> => {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const { input } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input: string };
      const down = input.includes(EMBEDDER_DOWN);
      response.writeHead(down ? 500 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(down ? { error: 'down' } : { embeddings: [vectorOf(input)] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
};

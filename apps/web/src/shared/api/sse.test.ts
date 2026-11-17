import { expect, it } from 'vitest';
import { readServerSentEvents } from './sse.ts';

/** A body that arrives in the given pieces, as a network would cut it. */
const body = (...pieces: Array<string | Uint8Array<ArrayBuffer>>) =>
  new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const piece of pieces)
        controller.enqueue(typeof piece === 'string' ? encoder.encode(piece) : piece);
      controller.close();
    },
  });

const all = async (stream: ReadableStream<Uint8Array<ArrayBuffer>>) => {
  const events = [];
  for await (const event of readServerSentEvents(stream)) events.push(event);
  return events;
};

it('reads events cut anywhere, including inside a line break and inside a character', async () => {
  const label = new TextEncoder().encode('event: step\ndata: {"label":"Buscando registros…"}\n\n');
  // «…» is three bytes: the cut falls inside it.
  const cut = label.indexOf(0xe2) + 1;
  expect(
    await all(
      body(
        label.slice(0, cut),
        label.slice(cut),
        'eve',
        'nt: answer\r',
        '\ndata: {"answer":"Hola"}\r\n\r',
        '\nevent:done\ndata: {}\n\n',
      ),
    ),
  ).toEqual([
    { event: 'step', data: '{"label":"Buscando registros…"}' },
    { event: 'answer', data: '{"answer":"Hola"}' },
    { event: 'done', data: '{}' },
  ]);
});

it('skips heartbeat comments and joins data lines', async () => {
  expect(
    await all(body(': ping\n\n', 'data: uno\ndata: dos\n\n: ping\n\nevent: done\ndata: {}\n\n')),
  ).toEqual([
    { event: 'message', data: 'uno\ndos' },
    { event: 'done', data: '{}' },
  ]);
});

it('drops an event the stream cut off before its blank line', async () => {
  expect(await all(body('event: step\ndata: {"label":"x"}\n\nevent: answer\ndata: {'))).toEqual([
    { event: 'step', data: '{"label":"x"}' },
  ]);
});

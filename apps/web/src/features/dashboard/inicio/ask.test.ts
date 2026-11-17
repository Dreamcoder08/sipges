import { HttpResponse, http } from 'msw';
import { beforeEach, expect, it, vi } from 'vitest';
import { resetApi, server } from '../../../test/server.ts';
import { NO_ANSWER, askAnalystStream } from './ask-stream.ts';
import { answerParts, askAnalyst } from './ask.ts';

beforeEach(() => resetApi());

const sources = [
  { n: 1, module: 'eventos', id: 'EV-1', title: 'Bloqueo de vía' },
  { n: 3, module: 'actores', id: 'A-7', title: '' },
];

it('splits an answer into text and the markers its sources resolve', () => {
  expect(answerParts('El bloqueo sigue [1]. La comunidad pide diálogo [3][2].', sources)).toEqual([
    { text: 'El bloqueo sigue ' },
    { source: sources[0] },
    { text: '. La comunidad pide diálogo ' },
    { source: sources[1] },
    { text: '[2]' },
    { text: '.' },
  ]);
});

it('keeps an answer without markers as one text part', () => {
  expect(answerParts('No encontré registros.', [])).toEqual([{ text: 'No encontré registros.' }]);
});

it('posts the question to the analyst in the project and validates the answer', async () => {
  let sent: { scope: string | null; body: unknown } | undefined;
  server.use(
    http.post('/system/analyst/ask', async ({ request }) => {
      sent = { scope: request.headers.get('X-SIPGES-Scope'), body: await request.json() };
      return HttpResponse.json({ answer: 'El bloqueo sigue [1].', sources: [sources[0]] });
    }),
  );
  const answer = await askAnalyst('DEMO/PRJ-DEMO', '¿Qué pasa?');
  expect(sent).toEqual({ scope: 'DEMO/PRJ-DEMO', body: { question: '¿Qué pasa?' } });
  expect(answer.sources).toEqual([sources[0]]);
});

it('keeps the known blocks, drops unknown or malformed ones, and accepts answers without blocks', async () => {
  const record = { n: 1, module: 'eventos', id: 'EV-1', title: 'Bloqueo de vía' };
  server.use(
    http.post('/system/analyst/ask', () =>
      HttpResponse.json({
        answer: 'El bloqueo sigue [1].',
        sources: [record],
        blocks: [
          { type: 'record', ...record },
          { type: 'chart', ...record },
          { type: 'alert', ...record },
          { type: 'timeline', ...record, entries: [{ date: '2026-03-02', text: 'Inicio' }] },
        ],
      }),
    ),
  );
  const answer = await askAnalyst('DEMO/PRJ-DEMO', '¿Qué pasa?');
  expect(answer.blocks).toEqual([
    { type: 'record', ...record },
    { type: 'timeline', ...record, entries: [{ date: '2026-03-02', text: 'Inicio' }] },
  ]);
  // An answer from before blocks existed still parses, with no blocks.
  server.use(
    http.post('/system/analyst/ask', () =>
      HttpResponse.json({ answer: 'Nada [1].', sources: [record] }),
    ),
  );
  expect((await askAnalyst('DEMO/PRJ-DEMO', '¿Y?')).blocks).toEqual([]);
});

/* The streamed ask (chat-first-ui T21): step labels while the analyst works, then the answer. */

const STREAM = '/system/analyst/ask/stream';
const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const eventStream = (...frames: string[]) =>
  new HttpResponse(frames.join(''), { headers: { 'content-type': 'text/event-stream' } });

it('streams the step labels, then returns the answer, asking with the same scope and body', async () => {
  let sent: { scope: string | null; accept: string | null; body: unknown } | undefined;
  server.use(
    http.post(STREAM, async ({ request }) => {
      sent = {
        scope: request.headers.get('X-SIPGES-Scope'),
        accept: request.headers.get('accept'),
        body: await request.json(),
      };
      return eventStream(
        ': ping\n\n',
        frame('step', { label: 'Buscando registros…' }),
        frame('step', { label: 'Leyendo la línea de tiempo…' }),
        frame('answer', { answer: 'El bloqueo sigue [1].', sources: [sources[0]] }),
        frame('done', {}),
      );
    }),
  );
  const steps: string[] = [];
  const answer = await askAnalystStream('DEMO/PRJ-DEMO', '¿Qué pasa?', {
    onStep: (label) => steps.push(label),
  });
  expect(sent).toEqual({
    scope: 'DEMO/PRJ-DEMO',
    accept: 'text/event-stream',
    body: { question: '¿Qué pasa?' },
  });
  expect(steps).toEqual(['Buscando registros…', 'Leyendo la línea de tiempo…']);
  expect(answer).toEqual({ answer: 'El bloqueo sigue [1].', sources: [sources[0]], blocks: [] });
});

it('turns an error event into the status and text /ask would have answered', async () => {
  for (const [status, detail] of [
    [409, 'La IA externa está desactivada en este proyecto.'],
    [422, 'La pregunta no puede estar vacía.'],
    [503, 'El analista no respondió: el servicio de IA no está disponible.'],
  ] as const) {
    server.use(
      http.post(STREAM, () =>
        eventStream(
          frame('step', { label: 'Buscando registros…' }),
          frame('error', { status, detail }),
          frame('done', {}),
        ),
      ),
    );
    await expect(askAnalystStream('DEMO/PRJ-DEMO', '¿Qué pasa?')).rejects.toMatchObject({
      name: 'ApiError',
      status,
      detail,
    });
  }
});

it('says the analyst reached no answer when the stream ends without one', async () => {
  server.use(http.post(STREAM, () => eventStream(frame('step', { label: 'Buscando registros…' }))));
  await expect(askAnalystStream('DEMO/PRJ-DEMO', '¿Qué pasa?')).rejects.toMatchObject({
    name: 'ApiError',
    status: 502,
    detail: NO_ANSWER,
  });
  expect(NO_ANSWER).toBe('El analista no llegó a una respuesta; vuelve a preguntar');
});

it('asks /ask once instead when the server has no stream route (404, 405) or does not stream', async () => {
  for (const older of [
    () => HttpResponse.json({ detail: 'Not Found' }, { status: 404 }),
    () => new HttpResponse(null, { status: 405 }),
    () => HttpResponse.json({ answer: 'otra cosa', sources: [] }),
  ]) {
    const calls: string[] = [];
    server.use(
      http.post(STREAM, () => {
        calls.push('stream');
        return older();
      }),
      http.post('/system/analyst/ask', async ({ request }) => {
        calls.push(`ask ${JSON.stringify(await request.json())}`);
        return HttpResponse.json({ answer: 'El bloqueo sigue [1].', sources: [sources[0]] });
      }),
    );
    const answer = await askAnalystStream('DEMO/PRJ-DEMO', '¿Qué pasa?');
    expect(answer.answer).toBe('El bloqueo sigue [1].');
    expect(calls).toEqual(['stream', 'ask {"question":"¿Qué pasa?"}']);
  }
});

it('does not fall back on other failures of the stream route', async () => {
  let asked = false;
  server.use(
    http.post(STREAM, () => HttpResponse.json({ detail: 'Sin permiso' }, { status: 403 })),
    http.post('/system/analyst/ask', () => {
      asked = true;
      return HttpResponse.json({ answer: '', sources: [] });
    }),
  );
  await expect(askAnalystStream('DEMO/PRJ-DEMO', '¿Qué pasa?')).rejects.toMatchObject({
    status: 403,
    detail: 'Sin permiso',
  });
  expect(asked).toBe(false);
});

it('stops reading the stream once aborted', async () => {
  const encoder = new TextEncoder();
  let more: (() => void) | undefined;
  server.use(
    http.post(STREAM, () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(frame('step', { label: 'Buscando registros…' })));
          more = () => {
            try {
              controller.enqueue(encoder.encode(frame('step', { label: 'Leyendo actores…' })));
            } catch {
              // Cancelled by the reader: nothing more can be sent.
            }
          };
        },
      });
      return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } });
    }),
  );
  const controller = new AbortController();
  const onStep = vi.fn((_label: string) => controller.abort());
  const asking = askAnalystStream('DEMO/PRJ-DEMO', '¿Qué pasa?', {
    signal: controller.signal,
    onStep,
  });
  await expect(asking).rejects.toMatchObject({ name: 'AbortError' });
  more?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(onStep.mock.calls).toEqual([['Buscando registros…']]);
});

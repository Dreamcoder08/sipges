import { HttpResponse, http } from 'msw';
import { beforeEach, expect, it } from 'vitest';
import { resetApi, server } from '../../../test/server.ts';
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

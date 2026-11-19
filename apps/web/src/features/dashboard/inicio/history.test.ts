import { expect, it } from 'vitest';
import type { AnalystAnswer } from './ask.ts';
import { HISTORY_CHARS, HISTORY_TURNS, historyOf } from './history.ts';
import type { Turn } from './turn.ts';

/* Follow-up questions (odd/tasks/chat-first-ui.md T9): what the tab sends of its earlier turns. */

const answer = (text: string): AnalystAnswer => ({ answer: text, sources: [], blocks: [] });
const answered = (id: number, question: string, text: string): Turn => ({
  id,
  question,
  state: 'answered',
  answer: answer(text),
});

it('sends the answered turns in order, question and answer text only', () => {
  const turns: Turn[] = [
    answered(1, '¿Qué pasa en el norte?', 'El bloqueo sigue [1].'),
    { id: 2, question: '¿Y el sur?', state: 'failed', error: new Error('502') },
    { id: 3, question: '¿Quién convoca?', state: 'stopped' },
    answered(4, '¿Desde cuándo?', 'Desde marzo [2].'),
    { id: 5, question: '¿Y ahora?', state: 'pending' },
  ];
  expect(historyOf(turns)).toEqual([
    { question: '¿Qué pasa en el norte?', answer: 'El bloqueo sigue [1].' },
    { question: '¿Desde cuándo?', answer: 'Desde marzo [2].' },
  ]);
});

it('keeps only the most recent six turns', () => {
  const turns = Array.from({ length: 8 }, (_, i) =>
    answered(i, `¿Pregunta ${i}?`, `Respuesta ${i}.`),
  );
  const history = historyOf(turns);
  expect(HISTORY_TURNS).toBe(6);
  expect(history).toHaveLength(6);
  expect(history[0]?.question).toBe('¿Pregunta 2?');
  expect(history.at(-1)?.question).toBe('¿Pregunta 7?');
});

it('drops the oldest turns that would pass 8,000 characters, counted as the API counts them', () => {
  // 'ñ' is one character; the API counts runes, not UTF-16 units or bytes.
  const long = 'ñ'.repeat(4_000);
  const turns = [answered(1, '¿a?', long), answered(2, '¿b?', long), answered(3, '¿c?', 'Corta.')];
  expect(HISTORY_CHARS).toBe(8_000);
  expect(historyOf(turns).map((e) => e.question)).toEqual(['¿b?', '¿c?']);
});

it('sends nothing when no turn was answered', () => {
  expect(historyOf([])).toEqual([]);
  expect(historyOf([{ id: 1, question: '¿Algo?', state: 'pending' }])).toEqual([]);
});

it('skips an answer of citation markers alone, which the API would refuse as blank', () => {
  const turns = [answered(1, '¿a?', ' [1][2] '), answered(2, '¿b?', 'Hay dos [1].')];
  expect(historyOf(turns)).toEqual([{ question: '¿b?', answer: 'Hay dos [1].' }]);
});

import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useThreadState } from './conversation.ts';
import { loadSaved } from './saved.ts';

/* odd/tasks/chat-first-ui.md T11 (L20): every answered conversation is kept in the browser,
 * per person and project; «Nueva pregunta» keeps the one it closes; a saved one opens again. */

const calls = vi.hoisted(() => [] as { question: string; history: unknown }[]);

vi.mock('./ask-stream.ts', () => ({
  NO_ANSWER: 'El analista no llegó a una respuesta.',
  askAnalystStream: (_scope: string, question: string, options: { history?: unknown }) => {
    calls.push({ question, history: options.history });
    return Promise.resolve({ answer: `Respuesta a ${question}.`, sources: [], blocks: [] });
  },
}));

beforeEach(() => {
  localStorage.clear();
  calls.length = 0;
});

it('saves the conversation as it is answered, and lists it once a new one starts', async () => {
  const { result } = renderHook(() => useThreadState('ACME/NORTE', 'ana'));
  await act(() => result.current.ask('¿Qué pasa en el norte?'));
  await act(() => result.current.ask('¿Desde cuándo?'));
  const stored = loadSaved('ana', 'ACME/NORTE', Date.now());
  expect(stored).toHaveLength(1);
  expect(stored[0]?.turns.map((t) => t.question)).toEqual([
    '¿Qué pasa en el norte?',
    '¿Desde cuándo?',
  ]);
  // The open conversation is not «Anteriores»; once «Nueva pregunta» closes it, it is.
  expect(result.current.saved).toEqual([]);
  act(() => result.current.clear());
  expect(result.current.turns).toEqual([]);
  expect(result.current.saved.map((c) => c.turns[0]?.question)).toEqual(['¿Qué pasa en el norte?']);
});

it('opens a saved conversation where follow-ups go on, saved again in place', async () => {
  const { result } = renderHook(() => useThreadState('ACME/NORTE', 'ana'));
  await act(() => result.current.ask('¿Qué pasa en el norte?'));
  act(() => result.current.clear());
  await act(() => result.current.ask('Otra cosa'));
  const first = result.current.saved[0];
  expect(first?.turns[0]?.question).toBe('¿Qué pasa en el norte?');
  act(() => result.current.open(first?.id ?? ''));
  expect(result.current.turns.map((t) => [t.question, t.state])).toEqual([
    ['¿Qué pasa en el norte?', 'answered'],
  ]);
  await act(() => result.current.ask('¿Y ahora?'));
  expect(calls.at(-1)).toEqual({
    question: '¿Y ahora?',
    history: [
      { question: '¿Qué pasa en el norte?', answer: 'Respuesta a ¿Qué pasa en el norte?.' },
    ],
  });
  const stored = loadSaved('ana', 'ACME/NORTE', Date.now());
  expect(stored).toHaveLength(2);
  expect(stored.find((c) => c.id === first?.id)?.turns).toHaveLength(2);
  // The conversation left open went to «Anteriores».
  expect(result.current.saved.map((c) => c.turns[0]?.question)).toEqual(['Otra cosa']);
});

it('deletes a saved conversation', async () => {
  const { result } = renderHook(() => useThreadState('P', 'ana'));
  await act(() => result.current.ask('¿Uno?'));
  act(() => result.current.clear());
  act(() => result.current.remove(result.current.saved[0]?.id ?? ''));
  expect(result.current.saved).toEqual([]);
  expect(loadSaved('ana', 'P', Date.now())).toEqual([]);
});

it('keeps another project and an unknown person apart', async () => {
  const { result, rerender } = renderHook(({ scope }) => useThreadState(scope, 'ana'), {
    initialProps: { scope: 'ACME/NORTE' },
  });
  await act(() => result.current.ask('¿Norte?'));
  act(() => result.current.clear());
  rerender({ scope: 'ACME/SUR' });
  expect(result.current.saved).toEqual([]);
  rerender({ scope: 'ACME/NORTE' });
  expect(result.current.saved).toHaveLength(1);
  const anonymous = renderHook(() => useThreadState('Q'));
  await act(() => anonymous.result.current.ask('¿Sin persona?'));
  expect(localStorage.length).toBe(1);
});

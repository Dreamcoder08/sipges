import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useThreadState } from './conversation.ts';

/* T9: the second question of a thread carries the first as history; a new thread starts empty. */

const calls = vi.hoisted(() => [] as { question: string; history: unknown }[]);

vi.mock('./ask-stream.ts', () => ({
  NO_ANSWER: 'El analista no llegó a una respuesta.',
  askAnalystStream: (_scope: string, question: string, options: { history?: unknown }) => {
    calls.push({ question, history: options.history });
    return Promise.resolve({ answer: `Respuesta a ${question} [1].`, sources: [], blocks: [] });
  },
}));

it('asks a follow-up with the earlier answered turns, and a cleared thread with none', async () => {
  const { result } = renderHook(() => useThreadState('DEMO/PRJ-DEMO'));
  await act(() => result.current.ask('¿Qué pasa en el norte?'));
  await act(() => result.current.ask('¿Desde cuándo?'));
  act(() => result.current.clear());
  await act(() => result.current.ask('¿Otra cosa?'));
  expect(calls).toEqual([
    { question: '¿Qué pasa en el norte?', history: [] },
    {
      question: '¿Desde cuándo?',
      history: [
        { question: '¿Qué pasa en el norte?', answer: 'Respuesta a ¿Qué pasa en el norte? [1].' },
      ],
    },
    { question: '¿Otra cosa?', history: [] },
  ]);
});

import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { forgetSavedConversations } from '../../../shared/lib/saved-conversations.ts';
import type { AnalystAnswer } from './ask.ts';
import { useThreadState } from './conversation.ts';
import { loadSaved, saveConversation } from './saved.ts';

/* chat-first-ui T11 (L20), the guards the independent verifier probed: sign-out while an answer is
 * on its way, keys that cannot collide, a person change on one mount, a shared computer. */

const pending = vi.hoisted(() => ({
  resolve: null as null | ((v: unknown) => void),
  defer: false,
}));
vi.mock('./ask-stream.ts', () => ({
  NO_ANSWER: 'El analista no llegó a una respuesta.',
  askAnalystStream: (_scope: string, question: string) =>
    pending.defer
      ? new Promise((resolve) => {
          pending.resolve = resolve;
        })
      : Promise.resolve({ answer: `Respuesta a ${question}.`, sources: [], blocks: [] }),
}));

const answer: AnalystAnswer = { answer: 'Una respuesta.', sources: [], blocks: [] };

beforeEach(() => {
  localStorage.clear();
  pending.defer = false;
  pending.resolve = null;
});

it('saves nothing for an answer that arrives after sign-out', async () => {
  pending.defer = true;
  const { result, unmount } = renderHook(() => useThreadState('ACME/NORTE', 'ana'));
  let done!: Promise<boolean>;
  act(() => {
    done = result.current.ask('¿Algo reservado?');
  });
  await vi.waitFor(() => expect(pending.resolve).toBeTruthy());
  forgetSavedConversations(); // logout()
  unmount(); // the screen goes to /login
  await act(async () => {
    pending.resolve?.({ answer: 'Tarde.', sources: [], blocks: [] });
    await done;
  });
  expect(Object.keys(localStorage)).toEqual([]);
});

it('keeps person "a:b" in project "c" apart from person "a" in project "b:c"', () => {
  const now = Date.now();
  saveConversation(
    'a:b',
    'c',
    { id: '1', updatedAt: now, turns: [{ question: '¿?', answer }] },
    now,
  );
  expect(loadSaved('a', 'b:c', now)).toEqual([]);
  expect(loadSaved('a:b', 'c', now)).toHaveLength(1);
});

it('does not carry the open conversation into another person on the same screen', async () => {
  const { result, rerender } = renderHook(({ person }) => useThreadState('P', person), {
    initialProps: { person: 'ana' },
  });
  await act(() => result.current.ask('¿De Ana?'));
  rerender({ person: 'beto' });
  expect(result.current.turns).toEqual([]);
  await act(() => result.current.ask('¿De Beto?'));
  const beto = loadSaved('beto', 'P', Date.now());
  expect(beto.flatMap((c) => c.turns.map((t) => t.question))).toEqual(['¿De Beto?']);
});

it("forgets other people's saved conversations when someone signs in on this browser", () => {
  const now = Date.now();
  saveConversation(
    'ana',
    'P',
    { id: '1', updatedAt: now, turns: [{ question: '¿De Ana?', answer }] },
    now,
  );
  saveConversation(
    'beto',
    'P',
    { id: '2', updatedAt: now, turns: [{ question: '¿De Beto?', answer }] },
    now,
  );
  renderHook(() => useThreadState('P', 'beto'));
  expect(loadSaved('ana', 'P', now)).toEqual([]);
  expect(loadSaved('beto', 'P', now)).toHaveLength(1);
});

it('«Borrar historial» also clears an entry it could not read', () => {
  const { result } = renderHook(() => useThreadState('P', 'ana'));
  saveConversation(
    'ana',
    'P',
    { id: '1', updatedAt: Date.now(), turns: [{ question: '¿?', answer }] },
    Date.now(),
  );
  const key = Object.keys(localStorage)[0] ?? '';
  localStorage.setItem(key, '{damaged');
  act(() => result.current.removeAll());
  expect(localStorage.getItem(key)).toBeNull();
});

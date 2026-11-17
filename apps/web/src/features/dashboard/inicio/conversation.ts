import { useRef, useState } from 'react';
import { type AnalystAnswer, askAnalyst } from './ask.ts';

/** One question and what became of it; the question is sent alone (no history yet, T9). */
export type Turn = { readonly id: number; readonly question: string } & (
  | { readonly state: 'pending' }
  | { readonly state: 'answered'; readonly answer: AnalystAnswer }
  | { readonly state: 'failed'; readonly error: unknown }
);

/** What the page's one status region says: the start and the end of each answer, once each. */
export const ANNOUNCE = {
  pending: 'El analista está buscando registros.',
  answered: 'Respuesta del analista lista.',
  failed: 'El analista no respondió.',
  stopped: 'Respuesta detenida.',
} as const;

const NO_TURNS: readonly Turn[] = [];

/**
 * Inicio's conversation (odd/tasks/chat-first-ui.md T5): turns kept in this component's memory
 * only, never in browser storage (T11 decides what is saved), and only for the project they were
 * asked in. A stopped or replaced request is let go: its late result is dropped.
 */
export const useAnalystThread = (scope: string) => {
  const [thread, setThread] = useState<{ scope: string; turns: readonly Turn[] }>({
    scope,
    turns: NO_TURNS,
  });
  const [announcement, setAnnouncement] = useState('');
  const active = useRef<number | null>(null);
  const sequence = useRef(0);
  const turns = thread.scope === scope ? thread.turns : NO_TURNS;

  const settle = (id: number, turn: Turn) =>
    setThread((current) => ({
      ...current,
      turns: current.turns.map((each) => (each.id === id ? turn : each)),
    }));

  /** Asks and resolves to whether an answer came back for this turn. */
  const ask = async (question: string): Promise<boolean> => {
    const id = ++sequence.current;
    active.current = id;
    setThread((current) => ({
      scope,
      turns: [
        ...(current.scope === scope ? current.turns : []),
        { id, question, state: 'pending' },
      ],
    }));
    setAnnouncement(ANNOUNCE.pending);
    let next: Turn;
    try {
      next = { id, question, state: 'answered', answer: await askAnalyst(scope, question) };
    } catch (error) {
      next = { id, question, state: 'failed', error };
    }
    if (active.current !== id) return false;
    active.current = null;
    settle(id, next);
    setAnnouncement(ANNOUNCE[next.state]);
    return next.state === 'answered';
  };

  /** Lets go of the pending answer (T7 adds the real abort); its question stays in the box. */
  const stop = () => {
    const id = active.current;
    if (id === null) return;
    active.current = null;
    setThread((current) => ({ ...current, turns: current.turns.filter((turn) => turn.id !== id) }));
    setAnnouncement(ANNOUNCE.stopped);
  };

  const clear = () => {
    active.current = null;
    setThread({ scope, turns: NO_TURNS });
    setAnnouncement('');
  };

  return { turns, pending: turns.at(-1)?.state === 'pending', announcement, ask, stop, clear };
};

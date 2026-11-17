import { useRef, useState } from 'react';
import { type AnalystAnswer, askAnalyst } from './ask.ts';

/** One question and what became of it; the question is sent alone (no history yet, T9). */
export type Turn = { readonly id: number; readonly question: string } & (
  | { readonly state: 'pending' }
  | { readonly state: 'answered'; readonly answer: AnalystAnswer }
  | { readonly state: 'failed'; readonly error: unknown }
  // «Detener» (T7): the request was aborted and its question went back to the composer.
  | { readonly state: 'stopped' }
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
 * Inicio's conversation (odd/tasks/chat-first-ui.md T5): turns kept in memory only, never in
 * browser storage (T11 decides what is saved), and only for the project they were asked in.
 * Stopping aborts the request (T7) and a replaced one is aborted too; a result that still arrives
 * is dropped. The shell holds one (`thread-context.tsx`, T19), so Inicio and the sidebar's
 * «Conversaciones» share it.
 */
export const useThreadState = (scope: string) => {
  const [thread, setThread] = useState<{ scope: string; turns: readonly Turn[] }>({
    scope,
    turns: NO_TURNS,
  });
  const [announcement, setAnnouncement] = useState('');
  const active = useRef<{ id: number; question: string; controller: AbortController } | null>(null);
  const sequence = useRef(0);
  const turns = thread.scope === scope ? thread.turns : NO_TURNS;

  const settle = (id: number, turn: Turn) =>
    setThread((current) => ({
      ...current,
      turns: current.turns.map((each) => (each.id === id ? turn : each)),
    }));

  /**
   * Says one message through the page's status region (T6 «Copiado»). A repeat gets a no-break
   * space, so screen readers that skip an identical message still read it (modern-web-guidance
   * copy-button).
   */
  const announce = (message: string) =>
    setAnnouncement((current) => (current === message ? `${message}\u00A0` : message));

  /** Lets go of the pending request, aborting it; returns what it asked. */
  const release = () => {
    const pending = active.current;
    active.current = null;
    pending?.controller.abort();
    return pending;
  };

  /** Asks and resolves to whether an answer came back for this turn. */
  const ask = async (question: string): Promise<boolean> => {
    // One answer at a time: one still pending is stopped, not left waiting forever.
    const previous = release();
    if (previous)
      settle(previous.id, { id: previous.id, question: previous.question, state: 'stopped' });
    const id = ++sequence.current;
    const controller = new AbortController();
    active.current = { id, question, controller };
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
      next = {
        id,
        question,
        state: 'answered',
        answer: await askAnalyst(scope, question, controller.signal),
      };
    } catch (error) {
      next = { id, question, state: 'failed', error };
    }
    // Stopped, replaced or cleared meanwhile: whatever came back (an AbortError included) is late.
    if (active.current?.id !== id) return false;
    active.current = null;
    settle(id, next);
    setAnnouncement(ANNOUNCE[next.state]);
    return next.state === 'answered';
  };

  /**
   * «Detener» (T7): aborts the request and marks its turn «Detenido»; the one thing said is
   * «Respuesta detenida.». Returns the question, which goes back to the composer for editing.
   */
  const stop = (): string | undefined => {
    const pending = release();
    if (!pending) return undefined;
    settle(pending.id, { id: pending.id, question: pending.question, state: 'stopped' });
    announce(ANNOUNCE.stopped);
    return pending.question;
  };

  const clear = () => {
    release();
    setThread({ scope, turns: NO_TURNS });
    setAnnouncement('');
  };

  return {
    turns,
    pending: turns.at(-1)?.state === 'pending',
    announcement,
    ask,
    stop,
    announce,
    clear,
  };
};

export type ThreadState = ReturnType<typeof useThreadState>;

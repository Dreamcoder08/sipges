import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { loadConversationView } from './answer-view.tsx';
import { historyOf } from './history.ts';
import {
  type SavedTurn,
  deleteSaved,
  parseSaved,
  purgeExpired,
  saveConversation,
  savedSnapshot,
  subscribeSaved,
} from './saved.ts';
import type { Turn } from './turn.ts';

/** What the page's one status region says: the start and the end of each answer, once each. */
export const ANNOUNCE = {
  pending: 'El analista está buscando registros.',
  answered: 'Respuesta del analista lista.',
  failed: 'El analista no respondió.',
  stopped: 'Respuesta detenida.',
} as const;

const NO_TURNS: readonly Turn[] = [];

/**
 * Inicio's conversation (odd/tasks/chat-first-ui.md T5): turns kept in memory, and only for the
 * project they were asked in. With a person, each answered conversation is also saved in this
 * browser under that person and project (T11, saved.ts), and earlier ones can be opened again.
 * Stopping aborts the request (T7) and a replaced one is aborted too; a result that still arrives
 * is dropped. The shell holds one (`thread-context.tsx`, T19), so Inicio and the sidebar's
 * «Conversaciones» share it.
 */
export const useThreadState = (scope: string, person?: string) => {
  const [thread, setThread] = useState<{ scope: string; turns: readonly Turn[] }>({
    scope,
    turns: NO_TURNS,
  });
  // T11 (L20): the open conversation, by project; a new project opens none until it asks.
  const [opened, setOpened] = useState<{ scope: string; id: string } | null>(null);
  const currentId = opened?.scope === scope ? opened.id : null;
  const snapshot = useSyncExternalStore(subscribeSaved, () =>
    person ? savedSnapshot(person, scope) : '',
  );
  const all = useMemo(() => parseSaved(snapshot), [snapshot]);
  // The person's earlier conversations of this project, without the one open now («Anteriores»).
  const saved = useMemo(() => all.filter((c) => c.id !== currentId), [all, currentId]);
  useEffect(() => {
    if (person) purgeExpired(person, scope, Date.now());
  }, [person, scope]);
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
    // The thread as it stood before this question: its answered turns are the follow-up's history.
    const history = historyOf(turns);
    const before = turns;
    let savingId = currentId;
    if (!savingId) {
      savingId = crypto.randomUUID();
      setOpened({ scope, id: savingId });
    }
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
    // Each step replaces the pending turn's progress text while this turn is still the one asked.
    const onStep = (step: string) => {
      if (active.current?.id === id) settle(id, { id, question, state: 'pending', step });
    };
    let next: Turn;
    try {
      // The ask and the answer view load together on the first question (T20); the turn above
      // already shows, and composer focus usually fetched the chunk ahead.
      const { askAnalystStream } = await loadConversationView();
      next = {
        id,
        question,
        state: 'answered',
        answer: await askAnalystStream(scope, question, {
          signal: controller.signal,
          onStep,
          history,
        }),
      };
    } catch (error) {
      next = { id, question, state: 'failed', error };
    }
    // Stopped, replaced or cleared meanwhile: whatever came back (an AbortError included) is late.
    if (active.current?.id !== id) return false;
    active.current = null;
    settle(id, next);
    setAnnouncement(ANNOUNCE[next.state]);
    if (next.state === 'answered' && person) {
      const answered: SavedTurn[] = [...before, next].flatMap((turn) =>
        turn.state === 'answered' ? [{ question: turn.question, answer: turn.answer }] : [],
      );
      saveConversation(
        person,
        scope,
        { id: savingId, updatedAt: Date.now(), turns: answered },
        Date.now(),
      );
    }
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

  /** «Nueva pregunta»: the open conversation stays saved, and a new one starts. */
  const clear = () => {
    release();
    setOpened(null);
    setThread({ scope, turns: NO_TURNS });
    setAnnouncement('');
  };

  /** Brings a saved conversation back as the open one; follow-ups go on from its turns. */
  const open = (id: string) => {
    const conversation = all.find((c) => c.id === id);
    if (!conversation) return;
    release();
    setOpened({ scope, id: conversation.id });
    setThread({
      scope,
      turns: conversation.turns.map((turn) => ({
        id: ++sequence.current,
        question: turn.question,
        state: 'answered' as const,
        answer: turn.answer,
      })),
    });
    setAnnouncement('');
  };

  /** Deletes a saved conversation; the open one, deleted, is saved again only on its next answer. */
  const remove = (id: string) => {
    if (!person) return;
    deleteSaved(person, scope, id);
    if (id === currentId) setOpened(null);
  };

  /** Deletes every saved conversation of the person in this project («Borrar historial»). */
  const removeAll = () => {
    if (!person) return;
    for (const conversation of all) deleteSaved(person, scope, conversation.id);
    setOpened(null);
  };

  return {
    turns,
    pending: turns.at(-1)?.state === 'pending',
    announcement,
    ask,
    stop,
    announce,
    clear,
    saved,
    open,
    remove,
    removeAll,
  };
};

export type ThreadState = ReturnType<typeof useThreadState>;

export type { Turn } from './turn.ts';

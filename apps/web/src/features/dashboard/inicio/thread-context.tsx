import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useInternalNavigate } from '../../../shared/lib/navigation.tsx';
import { type ThreadState, useThreadState } from './conversation.ts';

/** Inicio, the first tab of its destination: where every question is asked. */
export const INICIO_HREF = '/inicio';

/** What Inicio does when the shell asks it: start over, or bring one question into view. */
export type InicioHandle = {
  newConversation: () => void;
  showTurn: (id: number) => void;
};

type Request = { kind: 'new' } | { kind: 'turn'; id: number };

type SharedThread = {
  thread: ThreadState;
  /** «Nueva pregunta»: a fresh conversation on Inicio, with the cursor in the composer. */
  newQuestion: () => void;
  /** One question of the conversation, brought into view on Inicio. */
  showTurn: (id: number) => void;
  /** Inicio says it is on screen; the returned function says it left. */
  attach: (handle: InicioHandle) => () => void;
};

const ThreadContext = createContext<SharedThread | null>(null);

/** Ctrl+Mayús+O, or ⌘+Mayús+O on a Mac: a new question, as in the chat products (S2). */
export const isNewQuestionKey = (event: KeyboardEvent) =>
  (event.ctrlKey || event.metaKey) &&
  event.shiftKey &&
  !event.altKey &&
  event.key.toLowerCase() === 'o' &&
  !event.isComposing &&
  event.keyCode !== 229;

/**
 * The conversation held by the shell (odd/tasks/chat-first-ui.md T19), so Inicio and the
 * sidebar's «Conversaciones» read the same turns and the thread outlives a visit to another
 * screen. Still memory only and per project: nothing reaches browser storage (T11 decides what is
 * saved). From another screen, «Nueva pregunta» and a conversation entry open Inicio first and
 * the request waits until Inicio is on screen.
 */
export const AnalystThreadProvider = ({
  scope,
  children,
}: {
  scope: string;
  children: ReactNode;
}) => {
  const thread = useThreadState(scope);
  const navigate = useInternalNavigate();
  const inicio = useRef<InicioHandle | null>(null);
  const waiting = useRef<Request | null>(null);
  const run = (request: Request) => {
    const handle = inicio.current;
    if (handle) {
      if (request.kind === 'new') handle.newConversation();
      else handle.showTurn(request.id);
      return;
    }
    if (request.kind === 'new') thread.clear();
    waiting.current = request;
    navigate(INICIO_HREF);
  };
  const latest = useRef(run);
  useLayoutEffect(() => {
    latest.current = run;
  });
  // Stable, so Inicio attaches once.
  const [actions] = useState<Omit<SharedThread, 'thread'>>(() => ({
    newQuestion: () => latest.current({ kind: 'new' }),
    showTurn: (id) => latest.current({ kind: 'turn', id }),
    attach: (handle) => {
      inicio.current = handle;
      const request = waiting.current;
      waiting.current = null;
      if (request?.kind === 'new') handle.newConversation();
      else if (request) handle.showTurn(request.id);
      return () => {
        if (inicio.current === handle) inicio.current = null;
      };
    },
  }));

  // Ctrl/⌘+Mayús+O on every screen (shortcuts.ts lists it).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isNewQuestionKey(event)) return;
      event.preventDefault();
      actions.newQuestion();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions]);

  return <ThreadContext value={{ thread, ...actions }}>{children}</ThreadContext>;
};

/** The shell's conversation, or null outside it (a screen rendered on its own in a test). */
export const useSharedThread = () => useContext(ThreadContext);

/** Inicio's conversation: the shell's when there is one, else its own. */
export const useAnalystThread = (scope: string): ThreadState => {
  const shared = useContext(ThreadContext);
  const own = useThreadState(scope);
  return shared?.thread ?? own;
};

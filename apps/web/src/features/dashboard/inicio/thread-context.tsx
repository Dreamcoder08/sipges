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

type Request = { kind: 'new' } | { kind: 'turn'; id: number } | { kind: 'saved' };

type SharedThread = {
  thread: ThreadState;
  /** «Nueva pregunta»: a fresh conversation on Inicio, with the cursor in the composer. */
  newQuestion: () => void;
  /** One question of the conversation, brought into view on Inicio. */
  showTurn: (id: number) => void;
  /** A saved conversation («Anteriores», T11) opened on Inicio. */
  openConversation: (id: string) => void;
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
 * screen. Per project; each answered conversation is also saved in this browser for the person
 * signed in (T11), and the sidebar lists the earlier ones under «Anteriores». From another screen, «Nueva pregunta» and a conversation entry open Inicio first and
 * the request waits until Inicio is on screen.
 */
export const AnalystThreadProvider = ({
  scope,
  person,
  children,
}: {
  scope: string;
  /** The person signed in, whose conversations are saved in this browser (T11). */
  person?: string;
  children: ReactNode;
}) => {
  const thread = useThreadState(scope, person);
  const navigate = useInternalNavigate();
  const inicio = useRef<InicioHandle | null>(null);
  const waiting = useRef<Request | null>(null);
  const run = (request: Request) => {
    const handle = inicio.current;
    if (handle) {
      if (request.kind === 'new') handle.newConversation();
      else if (request.kind === 'turn') handle.showTurn(request.id);
      return;
    }
    if (request.kind === 'new') thread.clear();
    waiting.current = request;
    navigate(INICIO_HREF);
  };
  const latest = useRef(run);
  const latestOpen = useRef(thread.open);
  useLayoutEffect(() => {
    latest.current = run;
    latestOpen.current = thread.open;
  });
  // Stable, so Inicio attaches once.
  const [actions] = useState<Omit<SharedThread, 'thread'>>(() => ({
    newQuestion: () => latest.current({ kind: 'new' }),
    showTurn: (id) => latest.current({ kind: 'turn', id }),
    openConversation: (id) => {
      latest.current({ kind: 'saved' });
      latestOpen.current(id);
    },
    attach: (handle) => {
      inicio.current = handle;
      const request = waiting.current;
      waiting.current = null;
      if (request?.kind === 'new') handle.newConversation();
      else if (request?.kind === 'turn') handle.showTurn(request.id);
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

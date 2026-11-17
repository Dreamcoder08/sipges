import { use } from 'react';
import type * as ConversationViewModule from './conversation-view.ts';
import type { TurnResultProps } from './TurnResult.tsx';

type ConversationView = typeof ConversationViewModule;

let loaded: ConversationView | undefined;
let loading: Promise<ConversationView> | undefined;

/**
 * The conversation's code is a chunk of its own (odd/tasks/chat-first-ui.md T20): the empty Inicio
 * never asks or draws an answer, so the stream reader, the answer formatter, blocks and actions
 * stay out of the entry. One import is shared by every caller; a failed one (a chunk gone after a
 * deploy, or offline) is tried again next time.
 */
export const loadConversationView = () => {
  loading ??= import('./conversation-view.ts').then(
    (module) => (loaded = module),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
};

/** Fetches the chunk ahead, when the person starts to write a question. */
export const preloadAnswerView = () => {
  if (!loaded) void loadConversationView().catch(() => undefined);
};

/**
 * An answered or failed turn, drawn by the chunk. The thread asks through the chunk, so it is
 * loaded by the time a turn settles and this renders in the same commit; only when Inicio opens on
 * earlier turns before it loaded does it suspend to Thread's `Suspense`, which keeps the turn's
 * place.
 */
export const AnswerView = (props: TurnResultProps) => {
  const view = loaded ?? use(loadConversationView());
  return <view.TurnResult {...props} />;
};

import { AnalystAnswer } from './AnalystAnswer.tsx';
import { AnswerActions } from './AnswerActions.tsx';
import type { Turn } from './turn.ts';

/** A turn that came back: its answer, or why there is none. */
export type SettledTurn = Extract<Turn, { state: 'answered' | 'failed' }>;

export type TurnResultProps = {
  turn: SettledTurn;
  onSearch: (text: string) => void;
  /** «Volver a preguntar» (T6); absent where asking again cannot. */
  onRetry?: ((question: string) => void) | undefined;
  onAnnounce?: ((message: string) => void) | undefined;
  /** Another answer is pending: asking again waits for it. */
  busy: boolean;
};

/**
 * What an answered or failed turn shows (chat-first-ui T5, T6): the cited answer or its error, and
 * the actions under an answer. A chunk of its own (T20, `conversation-view.ts`): Inicio's first screen
 * never needs it.
 */
export const TurnResult = ({ turn, onSearch, onRetry, onAnnounce, busy }: TurnResultProps) => {
  const retry = onRetry && !busy ? () => onRetry(turn.question) : undefined;
  return (
    <>
      <AnalystAnswer
        question={turn.question}
        data={turn.state === 'answered' ? turn.answer : undefined}
        error={turn.state === 'failed' ? turn.error : undefined}
        onSearch={onSearch}
        onRetry={turn.state === 'failed' ? retry : undefined}
      />
      {turn.state === 'answered' ? (
        <AnswerActions
          answer={turn.answer.answer}
          sources={turn.answer.sources}
          onRetry={onRetry ? () => onRetry(turn.question) : undefined}
          onAnnounce={onAnnounce}
          busy={busy}
        />
      ) : null}
    </>
  );
};

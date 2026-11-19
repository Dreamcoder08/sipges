import type { Exchange } from './ask.ts';
import type { Turn } from './turn.ts';

/**
 * Follow-up questions (odd/tasks/chat-first-ui.md T9, owner decision L18): the earlier turns this
 * tab keeps travel with the next question, so «¿y desde cuándo?» means something. The server stores
 * none of them and checks the same limits; it also drops their [n] markers and passes them through
 * the egress guard.
 */

/** At most this many earlier turns, the API's limit. */
export const HISTORY_TURNS = 6;
/** At most this many characters of earlier questions and answers together, the API's limit. */
export const HISTORY_CHARS = 8_000;

/** An answer of citation markers alone: blank once the API drops its markers, so never sent. */
const markersOnly = (text: string) => text.replace(/\[[0-9]{1,4}\]/g, '').trim() === '';

/** Characters as the API counts them: code points, not UTF-16 units. */
const length = (text: string) => [...text].length;

/**
 * The answered turns, oldest first, keeping the most recent ones within HISTORY_TURNS and
 * HISTORY_CHARS. Failed, stopped and pending turns have no answer to send, nor has an answer of
 * citation markers alone.
 */
export const historyOf = (turns: readonly Turn[]): Exchange[] => {
  const history: Exchange[] = [];
  let chars = 0;
  for (const turn of [...turns].reverse()) {
    if (turn.state !== 'answered' || markersOnly(turn.answer.answer)) continue;
    const exchange = { question: turn.question, answer: turn.answer.answer };
    chars += length(exchange.question) + length(exchange.answer);
    if (history.length === HISTORY_TURNS || chars > HISTORY_CHARS) break;
    history.unshift(exchange);
  }
  return history;
};

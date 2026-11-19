import type { AnalystAnswer } from './ask.ts';

/**
 * One question and what became of it; answered turns travel with later questions (T9). A pending
 * turn's `step` is what the analyst is doing now, the stream's latest label (T21): shown, never
 * announced.
 */
export type Turn = { readonly id: number; readonly question: string } & (
  | { readonly state: 'pending'; readonly step?: string }
  | { readonly state: 'answered'; readonly answer: AnalystAnswer }
  | { readonly state: 'failed'; readonly error: unknown }
  // «Detener» (T7): the request was aborted and its question went back to the composer.
  | { readonly state: 'stopped' }
);

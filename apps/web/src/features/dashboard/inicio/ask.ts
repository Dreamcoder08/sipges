import { z } from 'zod';
import { requestJson } from '../../../shared/api/client.ts';

/**
 * The Inicio analyst (odd/tasks/agentic-analyst.md S2, T1d): one question, answered with
 * citations [n] to the records SIPGES's own tools returned. The answer is plain text; the
 * model never sends markup.
 */
const AnalystSource = z.object({
  n: z.number().int().positive(),
  module: z.string(),
  id: z.string(),
  title: z.string(),
});
export type AnalystSource = z.infer<typeof AnalystSource>;

const AnalystAnswer = z.object({ answer: z.string(), sources: z.array(AnalystSource) });
export type AnalystAnswer = z.infer<typeof AnalystAnswer>;

export const askAnalyst = (scope: string, question: string) =>
  requestJson('/system/analyst/ask', AnalystAnswer, {
    scope,
    method: 'POST',
    body: { json: { question } },
  });

export type AnswerPart = { readonly text: string } | { readonly source: AnalystSource };

const marker = /\[(\d{1,4})\]/g;

/** The answer as text and cited sources, in order; a marker no source resolves stays text. */
export const answerParts = (answer: string, sources: readonly AnalystSource[]): AnswerPart[] => {
  const parts: AnswerPart[] = [];
  let at = 0;
  for (const match of answer.matchAll(marker)) {
    const index = match.index;
    if (index > at) parts.push({ text: answer.slice(at, index) });
    const source = sources.find((s) => s.n === Number(match[1]));
    parts.push(source ? { source } : { text: match[0] });
    at = index + match[0].length;
  }
  if (at < answer.length) parts.push({ text: answer.slice(at) });
  return parts;
};

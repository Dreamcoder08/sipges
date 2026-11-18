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

/**
 * Typed blocks (S3): a kind the screen draws with its own components, on a record the analyst's
 * tools returned. The server already dropped unknown or malformed blocks; the screen drops any it
 * does not know too, so a newer server never breaks an older screen.
 */
const AnalystBlock = z.discriminatedUnion('type', [
  AnalystSource.extend({ type: z.literal('record') }),
  AnalystSource.extend({ type: z.literal('alert'), text: z.string().min(1) }),
  AnalystSource.extend({ type: z.literal('map') }),
  AnalystSource.extend({
    type: z.literal('timeline'),
    entries: z.array(z.object({ date: z.string(), text: z.string() })).min(1),
  }),
]);
export type AnalystBlock = z.infer<typeof AnalystBlock>;

const knownBlocks = z
  .array(z.unknown())
  .optional()
  .transform((items) =>
    (items ?? []).flatMap((item) => {
      const block = AnalystBlock.safeParse(item);
      return block.success ? [block.data] : [];
    }),
  );

export const AnalystAnswer = z.object({
  answer: z.string(),
  sources: z.array(AnalystSource),
  blocks: knownBlocks,
});
export type AnalystAnswer = z.infer<typeof AnalystAnswer>;

/** «Detener» aborts the request through `signal` (chat-first-ui T7); the server ends on it. */
export const askAnalyst = (scope: string, question: string, signal?: AbortSignal) =>
  requestJson('/system/analyst/ask', AnalystAnswer, {
    scope,
    method: 'POST',
    body: { json: { question } },
    ...(signal ? { signal } : {}),
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

const AnalystStatus = z.object({ available: z.boolean() });

/** Whether this installation has an Inicio analyst (a provider configured on the server). */
export const analystStatusQuery = (scope: string) => ({
  queryKey: ['analyst-status', scope] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    requestJson('/system/analyst', AnalystStatus, { scope, signal }),
  staleTime: 5 * 60_000,
});

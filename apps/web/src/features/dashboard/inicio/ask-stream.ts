import { z } from 'zod';
import { ApiError, isApiError, request } from '../../../shared/api/client.ts';
import { readServerSentEvents } from '../../../shared/api/sse.ts';
import { AnalystAnswer, askAnalyst } from './ask.ts';

/** What the turn says when the stream ended with no answer and no error (T21). */
export const NO_ANSWER = 'El analista no llegó a una respuesta; vuelve a preguntar';

const StepEvent = z.object({ label: z.string() });
const ErrorEvent = z.object({ status: z.number().int(), detail: z.string() });

/** The stream route is missing on an older server (404, or 405 where only /ask is routed). */
const noStreamRoute = (error: unknown) => isApiError(error, 404) || isApiError(error, 405);

const isEventStream = (response: Response) =>
  response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'text/event-stream';

/**
 * The question of `askAnalyst`, asked through `POST /system/analyst/ask/stream` (chat-first-ui
 * T10, T21) so the screen can say what the analyst is doing: `onStep` gets each step's fixed label
 * («Buscando registros…»), then this resolves to the same answer as /ask, or rejects with the
 * status and text /ask would have answered. The answer is never streamed as the model writes it
 * (L3). A server without the route (404, 405) or that does not answer with an event stream is
 * asked through /ask once instead. Aborting `signal` stops reading.
 */
export const askAnalystStream = async (
  scope: string,
  question: string,
  { signal, onStep }: { signal?: AbortSignal; onStep?: (label: string) => void } = {},
): Promise<AnalystAnswer> => {
  let response: Response;
  try {
    response = await request('/system/analyst/ask/stream', {
      scope,
      method: 'POST',
      body: { json: { question } },
      accept: 'text/event-stream',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (noStreamRoute(error)) return askAnalyst(scope, question, signal);
    throw error;
  }
  if (!response.body || !isEventStream(response)) {
    await response.body?.cancel().catch(() => undefined);
    return askAnalyst(scope, question, signal);
  }
  for await (const { event, data } of readServerSentEvents(response.body)) {
    if (event === 'step') {
      const step = StepEvent.safeParse(JSON.parse(data));
      if (step.success) onStep?.(step.data.label);
    } else if (event === 'answer') {
      // The rest of the stream is only `done`: leaving the loop lets go of the connection.
      return AnalystAnswer.parse(JSON.parse(data));
    } else if (event === 'error') {
      const body: unknown = JSON.parse(data);
      const failure = ErrorEvent.parse(body);
      throw new ApiError(failure.status, failure.detail, body);
    } else if (event === 'done') {
      break;
    }
  }
  // An abort ends the body too; it must read as one, not as a missing answer.
  signal?.throwIfAborted();
  throw new ApiError(502, NO_ANSWER, null);
};

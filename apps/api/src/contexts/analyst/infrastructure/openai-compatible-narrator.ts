import type { SanitisedPayload } from '../../privacy/application/index.ts';
import type { Narrator } from '../application/index.ts';
import { NARRATIVE_MAX_TOKENS, SYSTEM_PROMPT, briefingMessage } from './narrator-prompt.ts';

/** `{base}/v1/chat/completions`, or only `/chat/completions` when the base already ends in `/v1`. */
export const chatCompletionsUrl = (baseUrl: string): string => {
  const root = baseUrl.trim().replace(/\/+$/, '');
  return root.endsWith('/v1') ? `${root}/chat/completions` : `${root}/v1/chat/completions`;
};

// Errors are fixed texts: the key, the URL and the briefing never reach a log (docs/adr/0030).
const REQUEST_FAILED = 'The model provider request failed';
const NO_TEXT = 'The model returned no text';
const TOO_LARGE = 'The model answer was too large';

/** Same cap as the Go adapter's maxAnswerBytes. */
const MAX_ANSWER_BYTES = 1024 * 1024;

const isRedirect = (response: Response): boolean =>
  response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);

/** The body as text, or null when it exceeds the cap; never buffers more than the cap. */
const readCapped = async (response: Response): Promise<string | null> => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ANSWER_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const isRetryable = (status: number): boolean =>
  status === 408 || status === 409 || status === 429 || status >= 500;

type ChatCompletion = {
  choices?: Array<{ message?: { content?: unknown } | null; finish_reason?: string | null }>;
};

/**
 * Any OpenAI-compatible Chat Completions provider (OpenAI, DeepSeek, Ollama, OpenRouter, Groq,
 * vLLM) rewrites the extractive briefing as prose (docs/adr/0013). Only the configured base URL
 * is contacted: redirects fail the call. It retries once, like the Claude adapter.
 */
export const createOpenAiCompatibleNarrator = (config: {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  fetch?: typeof globalThis.fetch;
}): Narrator => {
  const url = chatCompletionsUrl(config.baseUrl);
  const apiKey = config.apiKey?.trim();
  const call = (body: string, signal: AbortSignal) =>
    (config.fetch ?? globalThis.fetch)(url, {
      method: 'POST',
      // Followed redirects could carry the key and briefing elsewhere; a 3xx just fails.
      redirect: 'manual',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body,
    });

  return {
    name: `openai-compatible:${config.model}`,
    async narrate(briefing: SanitisedPayload<string>, signal) {
      const body = JSON.stringify({
        model: config.model,
        max_tokens: NARRATIVE_MAX_TOKENS,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: briefingMessage(briefing) },
        ],
      });
      let response: Response | undefined;
      for (let attempt = 0; attempt < 2 && !response?.ok; attempt += 1) {
        if (signal.aborted) break;
        response = await call(body, signal).catch(() => undefined);
        if (response && isRedirect(response)) {
          void response.body?.cancel().catch(() => undefined);
          throw new Error(REQUEST_FAILED);
        }
        if (response && !response.ok && !isRetryable(response.status)) break;
      }
      if (!response?.ok) throw new Error(REQUEST_FAILED);

      const raw = await readCapped(response).catch(() => '');
      if (raw === null) throw new Error(TOO_LARGE);
      const parsed = ((): ChatCompletion | null => {
        try {
          return JSON.parse(raw) as ChatCompletion | null;
        } catch {
          return null;
        }
      })();
      const choice = parsed?.choices?.[0];
      if (choice?.finish_reason === 'length') throw new Error('The narrative was truncated');
      if (choice?.finish_reason === 'content_filter')
        throw new Error('The model declined the briefing');
      const content = choice?.message?.content;
      const text = typeof content === 'string' ? content.trim() : '';
      if (!text) throw new Error(NO_TEXT);
      return text;
    },
  };
};

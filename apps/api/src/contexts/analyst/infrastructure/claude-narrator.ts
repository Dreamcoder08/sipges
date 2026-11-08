import Anthropic from '@anthropic-ai/sdk';
import type { SanitisedPayload } from '../../privacy/application/index.ts';
import type { Narrator } from '../application/index.ts';
import { NARRATIVE_MAX_TOKENS, SYSTEM_PROMPT, briefingMessage } from './narrator-prompt.ts';

/**
 * Claude rewrites the extractive briefing as prose (docs/adr/0013). The API key is read by the
 * SDK from ANTHROPIC_API_KEY; nothing here stores or logs it.
 */
export const createClaudeNarrator = (config: {
  model: string;
  client?: Pick<Anthropic, 'beta'>;
}): Narrator => {
  const client = config.client ?? new Anthropic({ maxRetries: 1 });
  return {
    name: `claude:${config.model}`,
    async narrate(briefing: SanitisedPayload<string>, signal) {
      const response = await client.beta.messages.create(
        {
          model: config.model,
          max_tokens: NARRATIVE_MAX_TOKENS,
          output_config: { effort: 'low' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: briefingMessage(briefing) }],
        },
        { signal },
      );
      if (response.stop_reason === 'refusal') throw new Error('The model declined the briefing');
      if (response.stop_reason === 'max_tokens') throw new Error('The narrative was truncated');
      return response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('')
        .trim();
    },
  };
};

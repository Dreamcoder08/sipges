import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createClaudeNarrator } from '../../src/contexts/analyst/infrastructure/claude-narrator.ts';
import { exemptPayload } from '../../src/contexts/privacy/application/index.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { TEST_ENV } from '../support/test-app.ts';

const fakeClient = (response: Record<string, unknown>) => {
  const calls: unknown[][] = [];
  const client = {
    beta: { messages: { create: async (...args: unknown[]) => (calls.push(args), response) } },
  } as unknown as Pick<Anthropic, 'beta'>;
  return { client, calls };
};

describe('Claude narrator', () => {
  it('sends only the briefing, with refusal fallbacks, and returns the text', async () => {
    const { client, calls } = fakeClient({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: ' Párrafo [1]. ' },
      ],
    });
    const narrator = createClaudeNarrator({ model: 'claude-opus-5-5', client });
    const signal = new AbortController().signal;
    expect(narrator.name).toBe('claude:claude-opus-5-5');
    expect(await narrator.narrate(exemptPayload('- Hecho. [1]', 'constant'), signal)).toBe(
      'Párrafo [1].',
    );
    const [params, options] = calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(params).toMatchObject({
      model: 'claude-opus-5-5',
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: '<informe>\n- Hecho. [1]\n</informe>' }],
    });
    expect(options).toEqual({ signal });
  });

  it('rejects refusals and truncated answers', async () => {
    for (const stop_reason of ['refusal', 'max_tokens']) {
      const { client } = fakeClient({ stop_reason, content: [{ type: 'text', text: 'x [1]' }] });
      const narrator = createClaudeNarrator({ model: 'claude-opus-5-5', client });
      await expect(
        narrator.narrate(exemptPayload('b', 'constant'), new AbortController().signal),
      ).rejects.toThrow();
    }
  });

  it('is configured only explicitly and with a key', () => {
    expect(loadConfig(TEST_ENV).analyst).toBeUndefined();
    expect(() => loadConfig({ ...TEST_ENV, SIPGES_ANALYST_PROVIDER: 'anthropic' })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
    expect(() => loadConfig({ ...TEST_ENV, SIPGES_ANALYST_PROVIDER: 'otro' })).toThrow();
    expect(
      loadConfig({
        ...TEST_ENV,
        SIPGES_ANALYST_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'synthetic-test-value',
      }).analyst,
    ).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(() =>
      loadConfig({
        ...TEST_ENV,
        SIPGES_ANALYST_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'synthetic-test-value',
        SIPGES_ANALYST_MODEL: 'Bad Model!',
      }),
    ).toThrow(/SIPGES_ANALYST_MODEL/);
  });
});

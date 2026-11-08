import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/platform/config.ts';
import { TEST_ENV } from '../support/test-app.ts';

const openai = (env: Record<string, string> = {}) => ({
  ...TEST_ENV,
  SIPGES_ANALYST_PROVIDER: 'openai-compatible',
  SIPGES_ANALYST_BASE_URL: 'https://api.deepseek.com',
  SIPGES_ANALYST_API_KEY: 'synthetic-test-value',
  SIPGES_ANALYST_MODEL: 'deepseek-chat',
  ...env,
});

describe('openai-compatible analyst config (S2, S3)', () => {
  it('keeps the narrator off when unset or none', () => {
    expect(loadConfig(TEST_ENV).analyst).toBeUndefined();
    expect(loadConfig({ ...TEST_ENV, SIPGES_ANALYST_PROVIDER: 'none' }).analyst).toBeUndefined();
  });

  it('leaves the anthropic configuration unchanged', () => {
    const env = {
      ...TEST_ENV,
      SIPGES_ANALYST_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'synthetic-test-value',
    };
    expect(loadConfig(env).analyst).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(loadConfig({ ...env, SIPGES_ANALYST_MODEL: 'claude-haiku-5-5' }).analyst).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
    });
    expect(() => loadConfig({ ...env, ANTHROPIC_API_KEY: '' })).toThrow(
      'SIPGES_ANALYST_PROVIDER=anthropic requires ANTHROPIC_API_KEY',
    );
    expect(() => loadConfig({ ...env, SIPGES_ANALYST_MODEL: 'Bad Model!' })).toThrow(
      'SIPGES_ANALYST_MODEL is not a valid model id',
    );
  });

  it('rejects an unknown provider with the exact message', () => {
    expect(() => loadConfig({ ...TEST_ENV, SIPGES_ANALYST_PROVIDER: 'otro' })).toThrow(
      "SIPGES_ANALYST_PROVIDER must be unset, 'none', 'anthropic' or 'openai-compatible'",
    );
  });

  it('parses a complete configuration', () => {
    expect(loadConfig(openai()).analyst).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'synthetic-test-value',
      model: 'deepseek-chat',
    });
  });

  it('requires the base URL, key and model with the exact messages', () => {
    expect(() => loadConfig(openai({ SIPGES_ANALYST_BASE_URL: '' }))).toThrow(
      'SIPGES_ANALYST_PROVIDER=openai-compatible requires SIPGES_ANALYST_BASE_URL',
    );
    expect(() => loadConfig(openai({ SIPGES_ANALYST_API_KEY: '' }))).toThrow(
      'SIPGES_ANALYST_PROVIDER=openai-compatible requires SIPGES_ANALYST_API_KEY',
    );
    expect(() => loadConfig(openai({ SIPGES_ANALYST_MODEL: '' }))).toThrow(
      'SIPGES_ANALYST_PROVIDER=openai-compatible requires SIPGES_ANALYST_MODEL',
    );
  });

  it('does not default the model for this provider', () => {
    const env = openai();
    delete (env as Record<string, string | undefined>).SIPGES_ANALYST_MODEL;
    expect(() => loadConfig(env)).toThrow(/requires SIPGES_ANALYST_MODEL/);
  });

  it('accepts https anywhere and http only on loopback', () => {
    const message = 'SIPGES_ANALYST_BASE_URL must be https, or http on a loopback host';
    for (const url of [
      'http://api.example.org',
      'ftp://localhost',
      'not a url',
      'http://localhost.example.org:11434',
      'http://127.0.0.1.example.org',
    ])
      expect(() => loadConfig(openai({ SIPGES_ANALYST_BASE_URL: url }))).toThrow(message);
    for (const url of [
      'https://openrouter.ai/api',
      'http://localhost:11434',
      'http://127.0.0.1:8000/v1',
      'http://127.9.9.9',
      'http://[::1]:11434',
    ])
      expect(loadConfig(openai({ SIPGES_ANALYST_BASE_URL: url })).analyst).toMatchObject({
        baseUrl: url,
      });
  });

  it('does not require a key on a loopback base URL', () => {
    const env = openai({ SIPGES_ANALYST_BASE_URL: 'http://localhost:11434' });
    delete (env as Record<string, string | undefined>).SIPGES_ANALYST_API_KEY;
    expect(loadConfig(env).analyst).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'http://localhost:11434',
      apiKey: undefined,
      model: 'deepseek-chat',
    });
  });

  it('still requires a key on a non-loopback host', () => {
    const env = openai();
    delete (env as Record<string, string | undefined>).SIPGES_ANALYST_API_KEY;
    expect(() => loadConfig(env)).toThrow(/requires SIPGES_ANALYST_API_KEY/);
  });

  it('trims the key and treats a blank one as missing (S6)', () => {
    expect(loadConfig(openai({ SIPGES_ANALYST_API_KEY: ' k\n' })).analyst).toMatchObject({
      apiKey: 'k',
    });
    for (const key of [' ', '\n', ' \t\n'])
      expect(() => loadConfig(openai({ SIPGES_ANALYST_API_KEY: key }))).toThrow(
        'SIPGES_ANALYST_PROVIDER=openai-compatible requires SIPGES_ANALYST_API_KEY',
      );
    expect(
      loadConfig(
        openai({ SIPGES_ANALYST_BASE_URL: 'http://localhost:11434', SIPGES_ANALYST_API_KEY: '\n' }),
      ).analyst,
    ).toMatchObject({ apiKey: undefined });
  });

  it('judges loopback by the parsed host, not by userinfo or fragment tricks (S6)', () => {
    const message = 'SIPGES_ANALYST_BASE_URL must be https, or http on a loopback host';
    for (const url of [
      'http://127.0.0.1@evil.example',
      'http://evil.example#@localhost',
      'http://0.0.0.0',
    ])
      expect(() => loadConfig(openai({ SIPGES_ANALYST_BASE_URL: url }))).toThrow(message);
    for (const url of ['HTTP://LOCALHOST', 'http://evil.example@127.0.0.1'])
      expect(
        loadConfig(openai({ SIPGES_ANALYST_BASE_URL: url, SIPGES_ANALYST_API_KEY: '' })).analyst,
      ).toMatchObject({ provider: 'openai-compatible', baseUrl: url });
  });

  it('validates the model id charset and length', () => {
    for (const model of [
      'deepseek-chat',
      'deepseek/deepseek-chat',
      'llama3.1:8b',
      'GPT_4o.mini',
      'a'.repeat(128),
    ])
      expect(loadConfig(openai({ SIPGES_ANALYST_MODEL: model })).analyst).toMatchObject({ model });
    for (const model of ['bad model', 'modelo!', 'a'.repeat(129), 'x@y'])
      expect(() => loadConfig(openai({ SIPGES_ANALYST_MODEL: model }))).toThrow(
        'SIPGES_ANALYST_MODEL is not a valid model id',
      );
  });
});

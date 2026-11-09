import { describe, expect, it } from 'vitest';
import {
  chatCompletionsUrl,
  createOpenAiCompatibleNarrator,
} from '../../src/contexts/analyst/infrastructure/openai-compatible-narrator.ts';
import { SYSTEM_PROMPT } from '../../src/contexts/analyst/infrastructure/narrator-prompt.ts';
import { exemptPayload } from '../../src/contexts/privacy/application/index.ts';
import { createTestApp } from '../support/test-app.ts';

const KEY = 'synthetic-test-value';
const BASE = 'https://llm.invalid';

type Call = { url: string; init: RequestInit };

const scripted = (...responses: Array<Response | Error>) => {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next =
      responses[Math.min(calls.length, responses.length) - 1] ?? new Error('no response');
    if (next instanceof Error) throw next;
    return next.clone();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
};

const completion = (content: unknown, finish_reason: string | null = 'stop') =>
  Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason }] });

const make = (fetch: typeof globalThis.fetch, over: Record<string, string | undefined> = {}) =>
  createOpenAiCompatibleNarrator({
    baseUrl: BASE,
    apiKey: KEY,
    model: 'deepseek-chat',
    fetch,
    ...over,
  });

const narrate = (n: ReturnType<typeof make>, text = '- Hecho. [1]') =>
  n.narrate(exemptPayload(text, 'constant'), new AbortController().signal);

describe('chatCompletionsUrl (S2)', () => {
  it('appends /v1/chat/completions, or only /chat/completions after /v1', () => {
    expect(chatCompletionsUrl('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
    expect(chatCompletionsUrl('https://api.deepseek.com/')).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
    expect(chatCompletionsUrl('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    expect(chatCompletionsUrl('https://api.openai.com/v1/')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    expect(chatCompletionsUrl('https://openrouter.ai/api')).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    );
    expect(chatCompletionsUrl('http://localhost:11434')).toBe(
      'http://localhost:11434/v1/chat/completions',
    );
  });
});

describe('OpenAI-compatible narrator', () => {
  it('posts the shared prompt and the wrapped briefing and returns the trimmed text (S2)', async () => {
    const { fetch, calls } = scripted(completion(' Párrafo [1]. '));
    const narrator = make(fetch);
    const signal = new AbortController().signal;
    expect(narrator.name).toBe('openai-compatible:deepseek-chat');
    expect(await narrator.narrate(exemptPayload('- Hecho. [1]', 'constant'), signal)).toBe(
      'Párrafo [1].',
    );
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0] ?? { url: '', init: {} };
    expect(url).toBe(`${BASE}/v1/chat/completions`);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'deepseek-chat',
      max_tokens: 4000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: '<informe>\n- Hecho. [1]\n</informe>' },
      ],
    });
  });

  it('omits Authorization when there is no key (loopback)', async () => {
    const { fetch, calls } = scripted(completion('Ok [1]'));
    await narrate(make(fetch, { apiKey: undefined, baseUrl: 'http://localhost:11434' }));
    expect(calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(Object.keys(calls[0]?.init.headers as object)).not.toContain('authorization');
  });

  it('fails as truncated, declined or empty (S4)', async () => {
    await expect(narrate(make(scripted(completion('x [1]', 'length')).fetch))).rejects.toThrow(
      'The narrative was truncated',
    );
    await expect(
      narrate(make(scripted(completion('x [1]', 'content_filter')).fetch)),
    ).rejects.toThrow('The model declined the briefing');
    for (const body of [
      completion(''),
      completion('   '),
      completion(null),
      completion(undefined),
      Response.json({ choices: [] }),
      Response.json({}),
      new Response('not json'),
    ])
      await expect(narrate(make(scripted(body).fetch))).rejects.toThrow(
        'The model returned no text',
      );
  });

  it('accepts a missing finish_reason when there is text', async () => {
    expect(await narrate(make(scripted(completion('Ok [1]', null)).fetch))).toBe('Ok [1]');
  });

  it('retries once on a server error or a network failure, then fails with a fixed text', async () => {
    const ok = scripted(new Response('boom', { status: 503 }), completion('Ok [1]'));
    expect(await narrate(make(ok.fetch))).toBe('Ok [1]');
    expect(ok.calls).toHaveLength(2);

    const net = scripted(new TypeError('fetch failed'), completion('Ok [1]'));
    expect(await narrate(make(net.fetch))).toBe('Ok [1]');

    const down = scripted(new Response('boom', { status: 500 }));
    await expect(narrate(make(down.fetch))).rejects.toThrow('The model provider request failed');
    expect(down.calls).toHaveLength(2);
  });

  it('does not retry client errors', async () => {
    const denied = scripted(new Response('no', { status: 401 }), completion('Ok [1]'));
    await expect(narrate(make(denied.fetch))).rejects.toThrow('The model provider request failed');
    expect(denied.calls).toHaveLength(1);
  });

  it('never leaks the key, the URL or the briefing in errors', async () => {
    const briefing = 'Briefing secreto del caso';
    const leaky = new Error(`connect to ${BASE} with ${KEY} failed: ${briefing}`);
    const failures = [
      scripted(leaky),
      scripted(new Response(`${KEY} ${BASE} ${briefing}`, { status: 502 })),
      scripted(new Response(`${KEY}`, { status: 403 })),
      scripted(completion('x', 'length')),
      scripted(completion(`${KEY} ${BASE}`, 'content_filter')),
      scripted(new Response(`{"oops": "${KEY}`)),
    ];
    for (const { fetch } of failures) {
      const error = await narrate(make(fetch), briefing).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      const text = `${(error as Error).message} ${String((error as Error).cause ?? '')}`;
      for (const secret of [KEY, BASE, 'llm.invalid', briefing]) expect(text).not.toContain(secret);
    }
  });

  it('fails on a redirect without following or retrying it', async () => {
    for (const status of [301, 302, 307, 308]) {
      const redirected = scripted(
        new Response(null, { status, headers: { location: 'https://elsewhere.invalid/' } }),
        completion('Ok [1]'),
      );
      await expect(narrate(make(redirected.fetch))).rejects.toThrow(
        'The model provider request failed',
      );
      expect(redirected.calls).toHaveLength(1);
      expect(redirected.calls[0]?.init.redirect).toBe('manual');
    }
  });

  it('trims the key before sending it (S6)', async () => {
    const { fetch, calls } = scripted(completion('Ok [1]'));
    await narrate(make(fetch, { apiKey: ' k\n' }));
    expect(calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer k' });
    const blank = scripted(completion('Ok [1]'));
    await narrate(make(blank.fetch, { apiKey: ' \n' }));
    expect(Object.keys(blank.calls[0]?.init.headers as object)).not.toContain('authorization');
  });

  it('caps the response body at 1 MiB with a fixed text', async () => {
    const limit = 1024 * 1024;
    const filler = 'x'.repeat(limit);
    const big = scripted(
      new Response(JSON.stringify({ choices: [{ message: { content: filler } }] })),
    );
    await expect(narrate(make(big.fetch))).rejects.toThrow('The model answer was too large');
    // A body without a length header is cut off while streaming.
    const streamed = scripted(
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < 3; i += 1)
              controller.enqueue(new TextEncoder().encode('x'.repeat(limit / 2)));
            controller.close();
          },
        }),
      ),
    );
    await expect(narrate(make(streamed.fetch))).rejects.toThrow('The model answer was too large');
    // A declared length over the cap fails before reading.
    const declared = scripted(
      new Response('{}', { headers: { 'content-length': String(limit + 1) } }),
    );
    await expect(narrate(make(declared.fetch))).rejects.toThrow('The model answer was too large');
    // Just under the cap still works.
    const body = JSON.stringify({ choices: [{ message: { content: 'Ok [1]' } }] });
    expect(await narrate(make(scripted(new Response(body)).fetch))).toBe('Ok [1]');
  });
});

describe('citations stay checked by the analyst service (S5)', () => {
  const run = async (answer: string) => {
    const { fetch } = scripted(completion(answer));
    const t = await createTestApp({}, { narrator: make(fetch) });
    const admin = await t.login('admin', 'admin-password-123');
    const headers = { cookie: admin.cookie, 'content-type': 'application/json' };
    await t.request('/api/actores', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        payload: { ID_Actor: 'A-1', 'Nombre_Actor/Organizacion': 'Comunidad Norte' },
      }),
    });
    await t.request('/api/fuentes', {
      method: 'POST',
      headers,
      body: JSON.stringify({ payload: { ID_Fuente: 'F-1', Archivo_Fuente: 'Acta pública' } }),
    });
    await t.request('/system/links', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        link_type: 'relacionado_con',
        source: { module: 'actores', id: 'A-1' },
        target: { module: 'fuentes', id: 'F-1' },
        note: '',
      }),
    });
    await t.request('/system/v4/settings', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ external_ai: { enabled: true } }),
    });
    const res = await t.request('/system/briefing?module=actores&id=A-1', { headers });
    return (await res.json()) as Record<string, unknown>;
  };

  it('accepts a narrative that cites only sources of the briefing', async () => {
    expect(await run('La comunidad consta en el acta [1].')).toMatchObject({
      engine: 'asistido',
      narrator: 'openai-compatible:deepseek-chat',
    });
  });

  it('falls back to the extractive briefing when the provider cites a missing source', async () => {
    expect(await run('Dato inventado [9].')).toMatchObject({
      engine: 'extractivo',
      narrative: null,
      narrator: null,
    });
  });
});

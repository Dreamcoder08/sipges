import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  type Probe,
  SCREENS as PROD_SCREENS,
  httpProbe,
  loadConfig,
  login,
  parseEnvFile,
  runSteps,
  stats,
  summarize,
  totp,
} from '../../bench/prod-screens.ts';

// RFC 6238 appendix B seed for SHA-1, "12345678901234567890" in base32.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totp', () => {
  it('matches the RFC 6238 SHA-1 vectors truncated to 6 digits', () => {
    expect(totp(RFC_SECRET, 59_000)).toBe('287082');
    expect(totp(RFC_SECRET, 1_111_111_109_000)).toBe('081804');
    expect(totp(RFC_SECRET, 1_234_567_890_000)).toBe('005924');
    expect(totp(RFC_SECRET, 20_000_000_000_000)).toBe('353130');
  });

  it('accepts lowercase, spaced and padded secrets and rejects other characters', () => {
    expect(totp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq==', 59_000)).toBe('287082');
    expect(() => totp('GEZD1', 59_000)).toThrow(/base32/);
  });
});

describe('stats', () => {
  it('reports nearest-rank percentiles, the maximum and the count', () => {
    const samples = Array.from({ length: 20 }, (_, i) => 20 - i); // 20..1, unsorted
    expect(stats(samples)).toEqual({ n: 20, p50: 10, p95: 19, max: 20 });
  });

  it('reports nulls for no samples', () => {
    expect(stats([])).toEqual({ n: 0, p50: null, p95: null, max: null });
  });
});

describe('parseEnvFile', () => {
  it('keeps everything after the first = verbatim, including # and =', () => {
    const text = '# load account\nSIPGES_LOAD_USER=carga\n\nSIPGES_LOAD_PASSWORD=a#b=c \nnoise\n';
    expect(parseEnvFile(text)).toEqual({
      SIPGES_LOAD_USER: 'carga',
      SIPGES_LOAD_PASSWORD: 'a#b=c ',
    });
  });
});

describe('loadConfig', () => {
  const env = {
    SIPGES_LOAD_BASE_URL: 'https://sipges.example.test/',
    SIPGES_LOAD_USER: 'carga',
    SIPGES_LOAD_PASSWORD: 'synthetic-password',
    SIPGES_LOAD_TOTP: RFC_SECRET,
    SIPGES_LOAD_SCOPE: 'SIPGES/PRJ-DEMO',
  };

  it('reads every setting and normalises the base URL', () => {
    expect(loadConfig(env)).toEqual({
      baseUrl: 'https://sipges.example.test',
      username: 'carga',
      password: 'synthetic-password',
      totpSecret: RFC_SECRET,
      scope: 'SIPGES/PRJ-DEMO',
    });
  });

  it('names the missing variables without echoing any value', () => {
    const partial = { ...env, SIPGES_LOAD_PASSWORD: undefined, SIPGES_LOAD_TOTP: '  ' };
    expect(() => loadConfig(partial)).toThrow(
      'Missing settings: SIPGES_LOAD_PASSWORD, SIPGES_LOAD_TOTP',
    );
  });

  it('refuses plain HTTP except for the local machine', () => {
    expect(() =>
      loadConfig({ ...env, SIPGES_LOAD_BASE_URL: 'http://sipges.example.test' }),
    ).toThrow(/https/);
    expect(loadConfig({ ...env, SIPGES_LOAD_BASE_URL: 'http://127.0.0.1:8000' }).baseUrl).toBe(
      'http://127.0.0.1:8000',
    );
  });
});

/** A fake server: every GET takes `ms` on a shared fake clock and answers `status(path, n)`. */
const fakeServer = (ms: number, status: (path: string, n: number) => Probe['status']) => {
  let clock = 0;
  let calls = 0;
  const paths: string[] = [];
  return {
    paths,
    now: () => clock,
    get: async (path: string): Promise<Probe> => {
      paths.push(path);
      const n = calls++;
      await Promise.resolve();
      clock += ms;
      return { status: status(path, n), ms };
    },
  };
};

const SCREENS = { A: ['/a', '/b'], B: ['/c'] } as const;

describe('runSteps', () => {
  it('runs every step for its duration and measures requests and whole screens', async () => {
    const server = fakeServer(10, () => 200);
    const result = await runSteps({
      screens: SCREENS,
      steps: [1, 2],
      stepMs: 100,
      abortErrorRate: 0.2,
      get: server.get,
      now: server.now,
    });
    expect(result.stopped).toBeNull();
    expect(result.steps.map((s) => s.screens)).toEqual([1, 2]);
    const [first] = result.steps;
    expect(first?.errorRate).toBe(0);
    expect(first?.requests).toBe(first?.statuses['200']);
    expect(first?.screen['A']?.n).toBeGreaterThan(0);
    expect(first?.screen['B']?.n).toBeGreaterThan(0);
    expect(first?.path['/a']?.p50).toBe(10);
    expect(new Set(server.paths)).toEqual(new Set(['/a', '/b', '/c']));
  });

  it('stops inside the step and skips the next steps above the error-rate limit', async () => {
    const server = fakeServer(10, (_, n) => (n % 2 === 0 ? 200 : 503));
    const result = await runSteps({
      screens: SCREENS,
      steps: [1, 4, 8],
      stepMs: 60_000,
      abortErrorRate: 0.2,
      get: server.get,
      now: server.now,
    });
    expect(result.steps).toHaveLength(1);
    expect(result.stopped).toMatch(/20 %/);
    const [step] = result.steps;
    // It stopped well before the 60 s step would end (6000 fake requests).
    expect(step?.requests).toBeLessThan(100);
    expect(step?.errorRate).toBeGreaterThan(0.2);
    expect(step?.statuses['503']).toBeGreaterThan(0);
  });
});

describe('summarize', () => {
  it('prints counts and latencies only', async () => {
    const server = fakeServer(10, () => 200);
    const run = await runSteps({
      screens: SCREENS,
      steps: [1],
      stepMs: 50,
      abortErrorRate: 0.2,
      get: server.get,
      now: server.now,
    });
    const text = summarize('demo', run);
    expect(text).toContain('[demo] 1 pantalla');
    expect(text).toContain('A p50 ');
    expect(text).not.toMatch(/https?:/);
  });
});

/** Records POST/GET calls and answers like the SIPGES auth routes. */
const fakeAuth = (role: string) => {
  const calls: { method: string; path: string; body: string }[] = [];
  const fetcher = async (url: string | URL, init?: RequestInit) => {
    const { pathname } = new URL(url);
    calls.push({ method: init?.method ?? 'GET', path: pathname, body: String(init?.body ?? '') });
    if (pathname === '/login')
      return new Response('{}', { headers: { 'set-cookie': 'sipges_session=s1; Path=/' } });
    if (pathname === '/select-project')
      return new Response(null, {
        status: 303,
        headers: { 'set-cookie': 'sipges_scope=p1; Path=/' },
      });
    if (pathname === '/system/auth/me') return Response.json({ role });
    return new Response('{}');
  };
  return { calls, fetcher };
};

describe('login', () => {
  const config = {
    baseUrl: 'https://sipges.example.test',
    username: 'carga',
    password: 'synthetic-password',
    totpSecret: RFC_SECRET,
    scope: 'SIPGES/PRJ-DEMO',
  };

  it('signs in with a TOTP code, selects the scope and returns the session cookies', async () => {
    const { calls, fetcher } = fakeAuth('consulta');
    const session = await login(config, fetcher, 59_000);
    expect(session.cookie).toBe('sipges_session=s1; sipges_scope=p1');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /login',
      'POST /select-project',
      'GET /system/auth/me',
    ]);
    expect(new URLSearchParams(calls[0]?.body).get('otp')).toBe('287082');
    expect(new URLSearchParams(calls[1]?.body).get('scope')).toBe('SIPGES/PRJ-DEMO');
  });

  it('refuses to load-test with an account that is not read-only and logs it out', async () => {
    const { calls, fetcher } = fakeAuth('admin');
    await expect(login(config, fetcher, 59_000)).rejects.toThrow(/consulta/);
    expect(calls.at(-1)?.path).toBe('/logout');
  });
});

describe('SCREENS, the first paint of each measured screen', () => {
  const SHELL = [
    '/system/auth/me',
    '/system/auth/current-scope',
    '/system/auth/scopes',
    '/system/notifications?limit=30',
    '/system/v4/settings',
  ];

  it('opens every screen with the calls of the authenticated shell', () => {
    for (const paths of Object.values(PROD_SCREENS))
      expect(paths).toEqual(expect.arrayContaining(SHELL));
  });

  it('sends the exact URLs of Inicio and of a Registros list', () => {
    expect(PROD_SCREENS.Inicio).toEqual(
      expect.arrayContaining([
        '/api/dashboard',
        '/system/irsa',
        '/api/alertas?limit=500&offset=0&q=',
        '/api/eventos?limit=500&offset=0&q=',
      ]),
    );
    expect(PROD_SCREENS.Registros).toContain('/api/registros/summary?limit=500&offset=0');
    expect(PROD_SCREENS['Registros lista']).toEqual(
      expect.arrayContaining([
        '/api/registros/summary?limit=500&offset=0',
        '/api/fuentes?limit=500&offset=0&q=',
        '/system/uploads?linked_module=fuentes&limit=500',
      ]),
    );
  });

  it('asks only for URLs the go/no-go document lists as first paint', async () => {
    const doc = await readFile(
      new URL('../../../../docs/deployment/go-activation-reads.md', import.meta.url),
      'utf8',
    );
    const listed = new Set(/```text first-paint\n([\s\S]*?)```/.exec(doc)?.[1]?.split('\n'));
    const paths = [PROD_SCREENS.Inicio, PROD_SCREENS.Registros, PROD_SCREENS['Registros lista']]
      .flat()
      .filter((path) => !path.startsWith('/system/auth/'));
    expect(paths.filter((path) => !listed.has(path))).toEqual([]);
  });

  it('leaves out the SSE stream: it never finishes, so it is no request to time', () => {
    expect(Object.values(PROD_SCREENS).flat()).not.toContain('/system/events');
  });
});

describe('httpProbe', () => {
  const sent = async (path: string) => {
    let headers = new Headers();
    const fetcher = async (_url: string, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response('{}');
    };
    await httpProbe('https://sipges.example.test', 'c=1', fetcher, 1000, 'SIPGES/PRJ-DEMO')(path);
    return headers;
  };

  it('sends the project header on data calls, like the web client', async () => {
    expect((await sent('/api/dashboard')).get('x-sipges-scope')).toBe('SIPGES/PRJ-DEMO');
  });

  it('sends no project header on the session calls, like the web client', async () => {
    expect((await sent('/system/auth/me')).has('x-sipges-scope')).toBe(false);
  });
});

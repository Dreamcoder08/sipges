/**
 * Pure parts of the authenticated production screen stress (`prod-screens-stress.ts`):
 * settings, TOTP, login, the step loop and its statistics. Network and clock are injected,
 * so everything here runs in unit tests without a server.
 */
import { createHmac } from 'node:crypto';

/** The GET requests each screen fires together when it opens (read-only). */
export const SCREENS = {
  Inicio: [
    '/system/auth/me',
    '/system/auth/current-scope',
    '/system/notifications',
    '/api/dashboard',
    '/system/irsa',
    '/system/v4/settings',
    '/api/alertas',
  ],
  Registros: ['/system/auth/me', '/api/registros/summary'],
  IRSA: ['/system/irsa', '/system/model-status'],
} as const satisfies Record<string, readonly string[]>;

/** Only this role may be used: it can read, never write. */
export const LOAD_ROLE = 'consulta';

export type Config = {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly totpSecret: string;
  readonly scope: string;
};

const SETTINGS = {
  baseUrl: 'SIPGES_LOAD_BASE_URL',
  username: 'SIPGES_LOAD_USER',
  password: 'SIPGES_LOAD_PASSWORD',
  totpSecret: 'SIPGES_LOAD_TOTP',
  scope: 'SIPGES_LOAD_SCOPE',
} as const satisfies Record<keyof Config, string>;

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Reads `KEY=value` lines. Unlike dotenv parsers (and `util.parseEnv`), the value is everything
 * after the first `=`, verbatim: a password may contain `#`, quotes or spaces. Other lines are ignored.
 */
export const parseEnvFile = (text: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1]) env[match[1]] = match[2] ?? '';
  }
  return env;
};

/** Reads the settings; errors name the missing variables, never a value. */
export const loadConfig = (env: Readonly<Record<string, string | undefined>>): Config => {
  const missing = Object.values(SETTINGS).filter((key) => !env[key]?.trim());
  if (missing.length) throw new Error(`Missing settings: ${missing.join(', ')}`);
  const read = (key: keyof Config) => (env[SETTINGS[key]] ?? '').trim();
  const url = new URL(read('baseUrl'));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)))
    throw new Error(`${SETTINGS.baseUrl} must use https (plain http only for the local machine)`);
  return {
    baseUrl: url.origin,
    username: read('username'),
    // A password is used verbatim: surrounding spaces may be part of it.
    password: env[SETTINGS.password] ?? '',
    totpSecret: read('totpSecret'),
    scope: read('scope'),
  };
};

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const base32Decode = (secret: string) => {
  const clean = secret.replace(/[\s=]/g, '').toUpperCase();
  let bits = '';
  for (const ch of clean) {
    const value = BASE32.indexOf(ch);
    if (value < 0) throw new Error('TOTP secret is not base32');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
};

/** RFC 6238 TOTP with the otpauth defaults: SHA-1, 6 digits, 30 s period. */
export const totp = (secret: string, nowMs: number) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30_000)));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0xf;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
};

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Keeps the cookies the server sets, like a browser, and nothing else. */
class CookieJar {
  readonly #cookies = new Map<string, string>();

  take(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value) this.#cookies.set(name, value);
      else this.#cookies.delete(name);
    }
  }

  get header() {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

export type Session = { readonly cookie: string };

const postForm = async (
  config: Config,
  fetcher: Fetcher,
  jar: CookieJar,
  path: string,
  body: Record<string, string>,
) => {
  const response = await fetcher(config.baseUrl + path, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      origin: config.baseUrl,
      cookie: jar.header,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
  jar.take(response);
  await response.body?.cancel();
  return response.status;
};

/** Ends the session on the server; best effort, the run result does not depend on it. */
export const logout = async (config: Config, fetcher: Fetcher, cookie: string): Promise<void> => {
  try {
    await fetcher(config.baseUrl + '/logout', {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: config.baseUrl, cookie },
    }).then((response) => response.body?.cancel());
  } catch {
    // The session expires on its own.
  }
};

/**
 * Signs in with password and TOTP, selects the scope and checks the account is read-only.
 * Error messages carry HTTP statuses only, never response bodies.
 */
export const login = async (config: Config, fetcher: Fetcher, nowMs: number): Promise<Session> => {
  const jar = new CookieJar();
  const signed = await postForm(config, fetcher, jar, '/login', {
    username: config.username,
    password: config.password,
    otp: totp(config.totpSecret, nowMs),
  });
  if (signed !== 200) throw new Error(`Login failed: HTTP ${signed}`);
  const fail = async (message: string): Promise<never> => {
    await logout(config, fetcher, jar.header);
    throw new Error(message);
  };
  const selected = await postForm(config, fetcher, jar, '/select-project', { scope: config.scope });
  if (selected !== 303) return fail(`Project selection failed: HTTP ${selected}`);
  const me = await fetcher(config.baseUrl + '/system/auth/me', {
    headers: { cookie: jar.header, accept: 'application/json' },
  });
  const role = me.ok ? ((await me.json()) as { role?: unknown } | null)?.role : undefined;
  if (role !== LOAD_ROLE) return fail(`The load account must have the ${LOAD_ROLE} role`);
  return { cookie: jar.header };
};

export type Probe = {
  /** HTTP status, `timeout`, or `neterr:<code>`. */
  readonly status: number | string;
  readonly ms: number;
};

/** A real GET: drains and discards the body, so nothing from it is kept. */
export const httpProbe =
  (baseUrl: string, cookie: string, fetcher: Fetcher, timeoutMs: number) =>
  async (path: string): Promise<Probe> => {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetcher(baseUrl + path, {
        headers: { cookie, accept: 'application/json' },
        signal,
      });
      await response.arrayBuffer();
      return { status: response.status, ms: elapsed() };
    } catch (error) {
      const code = (error as { cause?: { code?: string }; name?: string }).cause?.code;
      return {
        status: signal.aborted ? 'timeout' : `neterr:${code ?? (error as Error).name}`,
        ms: elapsed(),
      };
    }
  };

export type Stats = {
  readonly n: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly max: number | null;
};

const nearestRank = (sorted: readonly number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;

/** Nearest-rank percentiles (the same definition as the other benchmarks). */
export const stats = (samples: readonly number[]): Stats => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    max: sorted.at(-1) ?? null,
  };
};

export type StepResult = {
  readonly screens: number;
  readonly requests: number;
  readonly errorRate: number;
  readonly statuses: Readonly<Record<string, number>>;
  /** Whole-screen latency: from the first request to the last answer, successful screens only. */
  readonly screen: Readonly<Record<string, Stats>>;
  /** Per-request latency of successful requests. */
  readonly path: Readonly<Record<string, Stats>>;
};

export type RunResult = {
  readonly steps: readonly StepResult[];
  /** Why the run ended early, or null when every step ran. */
  readonly stopped: string | null;
};

export type RunOptions = {
  readonly screens: Readonly<Record<string, readonly string[]>>;
  /** Concurrent virtual screens per step, in order. */
  readonly steps: readonly number[];
  readonly stepMs: number;
  /** Stop as soon as the error rate exceeds this fraction (after MIN_ERROR_SAMPLE requests). */
  readonly abortErrorRate: number;
  readonly get: (path: string) => Promise<Probe>;
  /** Monotonic milliseconds. */
  readonly now: () => number;
};

/** Requests a step needs before its error rate can stop the run. */
export const MIN_ERROR_SAMPLE = 20;

const runStep = async (options: RunOptions, concurrency: number) => {
  const names = Object.keys(options.screens);
  const perScreen = new Map<string, number[]>(names.map((name) => [name, []]));
  const perPath = new Map<string, number[]>();
  const statuses: Record<string, number> = {};
  let requests = 0;
  let errors = 0;
  const tooManyErrors = () =>
    requests >= MIN_ERROR_SAMPLE && errors / requests > options.abortErrorRate;
  const end = options.now() + options.stepMs;

  // Each virtual screen opens the screens in turn, starting at a different one.
  const visitor = async (first: number) => {
    for (let k = first; options.now() < end && !tooManyErrors(); k++) {
      const name = names[k % names.length] ?? '';
      const started = options.now();
      const probes = await Promise.all(
        (options.screens[name] ?? []).map(async (path) => ({ path, ...(await options.get(path)) })),
      );
      let ok = true;
      for (const probe of probes) {
        requests++;
        statuses[probe.status] = (statuses[probe.status] ?? 0) + 1;
        if (probe.status !== 200) {
          errors++;
          ok = false;
          continue;
        }
        const samples = perPath.get(probe.path) ?? [];
        samples.push(probe.ms);
        perPath.set(probe.path, samples);
      }
      if (ok) perScreen.get(name)?.push(Math.round(options.now() - started));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, (_, i) => visitor(i)));

  const result: StepResult = {
    screens: concurrency,
    requests,
    errorRate: requests ? Math.round((errors / requests) * 1000) / 1000 : 0,
    statuses,
    screen: Object.fromEntries([...perScreen].map(([name, ms]) => [name, stats(ms)])),
    path: Object.fromEntries([...perPath].map(([path, ms]) => [path, stats(ms)])),
  };
  return { result, aborted: tooManyErrors() };
};

/** Runs the steps in order and stops for good once the error rate goes over the limit. */
export const runSteps = async (options: RunOptions): Promise<RunResult> => {
  const steps: StepResult[] = [];
  for (const concurrency of options.steps) {
    const { result, aborted } = await runStep(options, concurrency);
    steps.push(result);
    if (aborted)
      return {
        steps,
        stopped: `errores por encima del ${Math.round(options.abortErrorRate * 100)} % con ${concurrency} pantallas`,
      };
  }
  return { steps, stopped: null };
};

/** A short Spanish summary: counts and latencies only, never response content. */
export const summarize = (label: string, run: RunResult) => {
  const lines: string[] = [];
  for (const step of run.steps) {
    const noun = step.screens === 1 ? 'pantalla' : 'pantallas';
    lines.push(
      `[${label}] ${step.screens} ${noun}: ${step.requests} pedidos, errores ${(step.errorRate * 100).toFixed(1)} % ${JSON.stringify(step.statuses)}`,
    );
    const screens = Object.entries(step.screen)
      .map(([name, s]) => `${name} p50 ${s.p50 ?? '-'} p95 ${s.p95 ?? '-'} máx ${s.max ?? '-'}`)
      .join(' | ');
    lines.push(`  pantalla completa (ms): ${screens}`);
    const slowest = Object.entries(step.path)
      .sort(([, a], [, b]) => (b.p95 ?? 0) - (a.p95 ?? 0))
      .slice(0, 4)
      .map(([path, s]) => `${path} ${s.p95}`)
      .join(' · ');
    lines.push(`  pedidos más lentos (p95, ms): ${slowest || '-'}`);
  }
  if (run.stopped) lines.push(`  ↳ detenido: ${run.stopped}`);
  return lines.join('\n');
};

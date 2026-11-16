// Shared by snapshot.mjs, compare.mjs and rehearse.mjs: sign-in over the public HTTP API of a
// running SIPGES, project-scoped requests and keyed hashes. Plain Node 24, no dependency, so the
// scripts can be copied to the laptop as they are. Nothing here prints a value it reads.
/* global fetch */
import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { URLSearchParams } from 'node:url';
import process from 'node:process';

/** Record modules of the API (`/api/<slug>`); one missing in an older version answers 404. */
export const MODULE_SLUGS = Object.freeze([
  'eventos',
  'actores',
  'demandas',
  'compromisos',
  'narrativas',
  'fuentes',
  'indicadores',
  'alertas',
  'acciones',
  'directorio',
  'priorizados',
  'usuarios',
  'roles',
  'proyectos',
  'intereses',
  'dialogos',
  'oportunidades',
  'hechos',
  'aarc',
  'buzon',
  'lecciones',
]);

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;

function base32(text) {
  let bits = '';
  for (const char of text.replace(/[\s=]/g, '').toUpperCase()) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new Error('The TOTP secret is not base32');
    bits += value.toString(2).padStart(5, '0');
  }
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

export const stepNow = () => Math.floor(Date.now() / STEP_MS);

/** RFC 6238 code (SHA-1, 30 s, 6 digits), as authenticator apps compute it. */
export function totp(secret, step = stepNow()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32(secret)).update(counter).digest();
  const at = mac[19] & 15;
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/**
 * The next step a code may use: the server refuses a step at or before the last one it
 * accepted and takes one step ahead. `stateFile` (synthetic rehearsals only) remembers the last
 * step across processes; the wait is at most one step.
 */
export async function nextStep(stateFile) {
  let last = -1;
  if (stateFile) {
    try {
      last = Number(JSON.parse(await readFile(stateFile, 'utf8')).lastStep);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const step = Math.max(stepNow(), last + 1);
  while (step > stepNow() + 1) await sleep(1000);
  if (stateFile) await writeFile(stateFile, JSON.stringify({ lastStep: step }), { mode: 0o600 });
  return step;
}

/**
 * The typed form a hash is taken of: arrays in order, object keys sorted, every value with its
 * JSON type, so the text "12" and the number 12 never hash alike, and key order never matters.
 */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

/** A keyed hash of the typed value: equal only for the same value with the snapshot's salt. */
export const keyed = (salt) => (value) =>
  createHmac('sha256', Buffer.from(salt, 'hex'))
    .update(JSON.stringify(canonical(value)) ?? 'undefined')
    .digest('hex');

/**
 * A keyed hash of raw bytes (an upload's content), with the same salt: a plain SHA-256 would let
 * anyone holding a known document confirm it is in the snapshot.
 */
export const keyedBytes = (salt) => (bytes) =>
  createHmac('sha256', Buffer.from(salt, 'hex')).update(bytes).digest('hex');

export const short = (hash) => hash.slice(0, 8);
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export class SignInError extends Error {
  constructor(status) {
    super(`Sign-in failed (status ${status})`);
    this.status = status;
  }
}

/** A route for messages: without its query or ids, which may be record or upload ids. */
const routeOf = (path) =>
  path.split('?')[0].replace(/^(\/api\/[^/]+|\/system\/uploads)\/[^/]+/, '$1/<id>');

/** A 3xx answer: never followed (the data would come from another server). */
export class RedirectError extends Error {
  constructor(method, path, status) {
    const route = routeOf(path);
    super(`${method} ${route} answered ${status}, a redirect (not followed)`);
    this.route = `${method} ${route}`;
    this.status = status;
  }
}

/**
 * Signs in like the login page (`POST /login`) and returns a session: `call(path, options)`
 * with `scope` sending X-SIPGES-Scope. Codes come from `otp`, or from `totpSecret` (synthetic
 * rehearsals). Throws SignInError when the server refuses. No request follows a redirect: a 3xx
 * answer throws RedirectError, unless `acceptRedirect` (the caller reads the 3xx itself).
 */
export async function signIn({ base, username, password, otp, totpSecret, totpState }) {
  base = base.replace(/\/+$/, '');
  let cookie = '';
  const call = async (path, { scope, headers = {}, acceptRedirect = false, ...init } = {}) => {
    const response = await fetch(base + path, {
      ...init,
      redirect: 'manual',
      headers: {
        Origin: base,
        Accept: 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(scope ? { 'X-SIPGES-Scope': scope } : {}),
        ...headers,
      },
    });
    if (!acceptRedirect && response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new RedirectError(init.method ?? 'GET', path, response.status);
    }
    const set = response.headers.getSetCookie?.() ?? [];
    const session = set.map((c) => c.split(';')[0]).filter((c) => c.startsWith('sipges_session='));
    if (session.length) cookie = session.at(-1);
    return response;
  };
  const code = otp ?? (totpSecret ? totp(totpSecret, await nextStep(totpState)) : '');
  const response = await call('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, otp: code }),
  });
  await response.arrayBuffer();
  if (response.status !== 200 || !cookie) throw new SignInError(response.status);
  return { call, withCode: code !== '' };
}

/**
 * The parsed JSON body of a GET answer. A body that is not JSON is named by its route only: the
 * parse error's own message quotes part of the body, which may be record content.
 */
export async function readJson(response, path) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `GET ${routeOf(path)} answered ${response.status} with a body that is not valid JSON`,
    );
  }
}

/** GET returning parsed JSON, or `{ status }` when the answer is not 200. */
export async function getJson(session, path, scope) {
  const response = await session.call(path, { scope });
  if (response.status !== 200) {
    await response.arrayBuffer();
    return { status: response.status };
  }
  return { status: 200, body: await readJson(response, path) };
}

const VALUED = new Set([
  '--url',
  '--user',
  '--password-file',
  '--otp',
  '--totp-secret-file',
  '--totp-state',
  '--out',
  '--before',
  '--probe-limit',
]);

/** `--name value` pairs, each at most once; `allowed` lists the names a script takes. */
export function parseArgs(args, allowed) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const [key, value] = [args[i], args[i + 1]];
    if (!VALUED.has(key) || !allowed.includes(key) || value === undefined || options[key])
      throw new Error(`Invalid option ${key ?? ''}; use --help`);
    options[key] = value;
  }
  return options;
}

const TERMINAL = { input: process.stdin, output: process.stderr };

async function ask(question, { input, output } = TERMINAL) {
  if (!input.isTTY) return '';
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Asks without showing what is typed: the terminal goes to raw mode (Node's own TTY support, on
 * the Windows console and a Linux tty alike), so nothing is echoed; Enter ends the answer,
 * Backspace erases, other control keys are ignored and Ctrl+C cancels. Raw mode is always undone.
 * Without a terminal (input piped) the answer is empty, like `ask`.
 */
export function readHidden(question, { input, output } = TERMINAL) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return Promise.resolve('');
  return new Promise((done, fail) => {
    const wasRaw = Boolean(input.isRaw);
    let value = '';
    const finish = (error) => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (error) fail(error);
      else done(value.trim());
    };
    const onData = (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const char of text) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') return finish(new Error('Cancelado (Ctrl+C)'));
        // An escape sequence (an arrow or function key) arrives whole: drop the rest of it.
        if (char === '\u001b') break;
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (char >= ' ') value += char;
      }
    };
    output.write(question);
    input.setRawMode(true);
    input.on('data', onData);
    input.resume();
  });
}

/**
 * Credentials from the options: the password from `--password-file` (for example the state
 * folder's `admin-password`) or SIPGES_MIGRATION_PASSWORD or a prompt; the MFA code from
 * `--otp`, `--totp-secret-file` (synthetic rehearsals) or a prompt (empty for no MFA).
 */
export async function credentials(options, terminal = TERMINAL) {
  const password = options['--password-file']
    ? (await readFile(options['--password-file'], 'utf8')).trim()
    : (process.env.SIPGES_MIGRATION_PASSWORD ?? (await readHidden('Contraseña: ', terminal)));
  const totpSecret = options['--totp-secret-file']
    ? (await readFile(options['--totp-secret-file'], 'utf8')).trim()
    : undefined;
  const otp =
    options['--otp'] ??
    (totpSecret ? undefined : await ask('Código MFA (vacío si no tiene): ', terminal));
  return {
    base: options['--url'],
    username: options['--user'] ?? 'admin',
    password,
    otp: otp || undefined,
    totpSecret,
    totpState: options['--totp-state'],
  };
}

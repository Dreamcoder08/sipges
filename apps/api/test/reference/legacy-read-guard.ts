import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test-only filesystem guard: the repository `data/` directory holds real reference datasets
 * (incident L12 in odd/tasks/desktop-updates.md). Test files that may reach the legacy file
 * reader mock `node:fs` and `node:fs/promises` with these wrappers, so any call that names a
 * path inside `data/` is refused before the real filesystem is touched. A test may register
 * synthetic content for one legacy path; only `readFile`/`readFileSync` return it.
 */
export const LEGACY_DATA_DIR = fileURLToPath(new URL('../../../../data', import.meta.url));

export class LegacyReadBlocked extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`Legacy repository data read blocked in tests: ${path}`);
    this.path = path;
  }
}

/** Every attempt to reach `data/`, and every path that the real filesystem did receive. */
export const legacyReads = { attempts: [] as string[], passedThrough: [] as string[] };
const fakes = new Map<string, string>();

export const fakeLegacyFile = (name: string, content: string) =>
  void fakes.set(resolve(LEGACY_DATA_DIR, name), content);

export const resetLegacyGuard = () => {
  legacyReads.attempts.length = 0;
  legacyReads.passedThrough.length = 0;
  fakes.clear();
};

export const isLegacyDataPath = (path: string) => {
  const r = relative(LEGACY_DATA_DIR, path);
  return (
    r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('../') && !r.startsWith('..\\'))
  );
};

const asPath = (value: unknown): string | undefined => {
  if (typeof value === 'string') return resolve(value);
  if (value instanceof URL) return value.protocol === 'file:' ? fileURLToPath(value) : undefined;
  if (Buffer.isBuffer(value)) return resolve(value.toString());
  return undefined;
};

type AnyFn = (...args: unknown[]) => unknown;
const wrappers = new WeakSet<object>();

/** Throws unless every given function is a guard wrapper; call it before any test runs. */
export const assertGuardInstalled = (...fns: unknown[]) => {
  if (!fns.every((fn) => typeof fn === 'function' && wrappers.has(fn)))
    throw new Error('Legacy read guard is not installed; refusing to run');
};

/** Settles to a label, never to file content, so a failed assertion cannot print data. */
export const outcome = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof LegacyReadBlocked ? 'blocked' : 'failed'),
  );

const wrap = (name: string, fn: AnyFn, sync: boolean): AnyFn => {
  const guarded = function (this: unknown, ...args: unknown[]) {
    const paths = args.slice(0, 2).map(asPath);
    const hit = paths.find((path) => path !== undefined && isLegacyDataPath(path));
    if (hit !== undefined) {
      legacyReads.attempts.push(hit);
      const fake = fakes.get(hit);
      if (fake !== undefined && name === 'readFile' && !sync) return Promise.resolve(fake);
      if (fake !== undefined && name === 'readFileSync') return fake;
      if (sync) throw new LegacyReadBlocked(hit);
      return Promise.reject(new LegacyReadBlocked(hit));
    }
    for (const path of paths) if (path !== undefined) legacyReads.passedThrough.push(path);
    return fn.apply(this, args);
  };
  wrappers.add(guarded);
  return guarded;
};

// Constructors (Stats, Dirent, ReadStream…) and non-functions pass through untouched.
const wrapAll = <T extends object>(module: T, sync: boolean): T => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(module)) {
    out[key] =
      typeof value === 'function' && /^[a-z]/.test(key) ? wrap(key, value as AnyFn, sync) : value;
  }
  return out as T;
};

/** Factory body for `vi.mock('node:fs/promises', …)`. */
export const guardFsPromises = <T extends object>(actual: T): T => {
  const wrapped = wrapAll(actual, false);
  return { ...wrapped, default: wrapped } as T;
};

/** Factory body for `vi.mock('node:fs', …)`, including its `promises` namespace. */
export const guardFs = <T extends object>(actual: T): T => {
  // Sync and callback APIs (fs.readFile(path, cb)) alike are refused by throwing synchronously.
  const wrapped = wrapAll(actual, true) as Record<string, unknown>;
  const promises = (actual as { promises?: object }).promises;
  if (promises) wrapped.promises = guardFsPromises(promises);
  return { ...wrapped, default: wrapped } as T;
};

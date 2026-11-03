import type { Clock, TenantSummary } from './ports.ts';

/** How long a user's grants answer the per-request project resolution in one isolate. */
export const GRANT_CACHE_TTL_MS = 30_000;
const MAX_USERS = 1_000;

/**
 * Grants per user for the request path. Every authenticated request resolves its project
 * from the user's grants; a 30 s copy saves that query on repeated requests.
 *
 * Within this isolate a grant change is visible at once: `forget` drops the copy, and a lookup
 * that started before any `forget` never stores what it read (one generation counter for all
 * users keeps the bookkeeping bounded; it only costs an extra miss after unrelated changes). Other isolates keep
 * their copy for at most the TTL, so a revoked project can still resolve there for up to 30 s.
 * Only settled values are kept, never a lookup in flight (no request waits on another's I/O).
 */
export const createGrantCache = (
  load: (username: string) => Promise<TenantSummary[]>,
  clock: Clock,
) => {
  const entries = new Map<string, { at: number; grants: readonly TenantSummary[] }>();
  let generation = 0;

  return {
    async get(username: string): Promise<readonly TenantSummary[]> {
      const now = clock.now().getTime();
      const cached = entries.get(username);
      if (cached && now - cached.at < GRANT_CACHE_TTL_MS) return cached.grants;
      const started = generation;
      // Frozen: every request in the isolate shares this copy, so no caller may change it.
      const grants = Object.freeze(
        (await load(username)).map((grant) => Object.freeze({ ...grant })),
      );
      if (generation === started) {
        if (entries.size >= MAX_USERS && !entries.has(username)) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
        entries.set(username, { at: now, grants });
      }
      return grants;
    },
    forget(username: string): void {
      entries.delete(username);
      generation += 1;
    },
  };
};

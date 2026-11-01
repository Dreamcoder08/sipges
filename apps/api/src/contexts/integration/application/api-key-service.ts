import { type Result, err, ok } from '@sipges/kernel';
import {
  type ApiPrincipal,
  type KeyAccess,
  type KeyClearance,
  formatToken,
  parseToken,
} from '../domain/api-key.ts';
import type { ApiKeyStore, Clock, KeyCrypto } from './ports.ts';

/** last_used_at is refreshed at most this often, so reads do not write on every call. */
const TOUCH_INTERVAL_MS = 60_000;

export const createApiKeyService = (deps: {
  store: ApiKeyStore;
  crypto: KeyCrypto;
  clock: Clock;
}) => {
  const { store, crypto, clock } = deps;
  return {
    list: (tenantId: string) => store.list(tenantId),

    /** The token is returned once; only its hash is stored. */
    async create(
      tenantId: string,
      input: { name: string; access: KeyAccess; clearance: KeyClearance },
      actor: string,
    ): Promise<Result<{ id: number; token: string; prefix: string }, 'duplicate'>> {
      const prefix = crypto.prefix();
      const secret = crypto.secret();
      const created = await store.create(
        tenantId,
        { ...input, name: input.name.trim(), prefix, secretHash: crypto.hash(secret) },
        actor,
        clock.now(),
      );
      return created.ok
        ? ok({ id: created.id, token: formatToken(prefix, secret), prefix })
        : err(created.error);
    },

    revoke: (tenantId: string, id: number) => store.revoke(tenantId, id, clock.now()),

    /** Resolves a bearer token to its key, or null for anything unknown, revoked or malformed. */
    async authenticate(token: string | null): Promise<ApiPrincipal | null> {
      const parsed = token ? parseToken(token) : null;
      if (!parsed) return null;
      const found = await store.active(parsed.prefix);
      if (!found || !crypto.matches(parsed.secret, found.secretHash)) return null;
      const now = clock.now();
      if (!found.lastUsedAt || now.getTime() - found.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
        await store.touch(found.keyId, now);
      }
      return {
        keyId: found.keyId,
        tenantId: found.tenantId,
        name: found.name,
        access: found.access,
        clearance: found.clearance,
      };
    },
  };
};

export type ApiKeyService = ReturnType<typeof createApiKeyService>;

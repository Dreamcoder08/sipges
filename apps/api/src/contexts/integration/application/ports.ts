import type { ApiPrincipal, KeyAccess, KeyClearance } from '../domain/api-key.ts';

export type StoredKey = {
  readonly id: number;
  readonly name: string;
  readonly prefix: string;
  readonly access: KeyAccess;
  readonly clearance: KeyClearance;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
};

export type NewKey = {
  readonly name: string;
  readonly prefix: string;
  readonly secretHash: string;
  readonly access: KeyAccess;
  readonly clearance: KeyClearance;
};

/** api_keys is global (looked up before a tenant is known); writes are audited in the tenant. */
export type ApiKeyStore = {
  create(
    tenantId: string,
    key: NewKey,
    actor: string,
    at: Date,
  ): Promise<{ ok: true; id: number } | { ok: false; error: 'duplicate' }>;
  list(tenantId: string): Promise<StoredKey[]>;
  revoke(tenantId: string, id: number, at: Date): Promise<boolean>;
  /** An active (not revoked) key by prefix, with its stored hash. */
  active(
    prefix: string,
  ): Promise<(ApiPrincipal & { secretHash: string; lastUsedAt: Date | null }) | null>;
  touch(id: number, at: Date): Promise<void>;
};

export type KeyCrypto = {
  /** 12 lowercase hex characters. */
  prefix(): string;
  /** 43 base64url characters (256 bits). */
  secret(): string;
  hash(secret: string): string;
  /** Constant-time comparison of a secret against a stored hash. */
  matches(secret: string, hash: string): boolean;
};

export type Clock = { now(): Date };

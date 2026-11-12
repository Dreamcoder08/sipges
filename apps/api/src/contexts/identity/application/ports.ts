import type { ThrottleDecision } from '../domain/login-throttle.ts';
import type { Identity, NewAccount, Role, SessionIdentity } from '../domain/user.ts';

export type StoredUser = Identity & {
  readonly passwordHash: string;
  readonly active: boolean;
  readonly totpSecretSealed: string | null;
  readonly totpEnabled: boolean;
  readonly totpLastStep: number | null;
  readonly googleEmail: string | null;
};

/** A session as its owner may see it: the hash stays inside the application layer. */
export type StoredSession = {
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly viaGoogle: boolean;
};

/** The audit row a session write appends to the active project's trail. */
export type SessionAudit = {
  readonly action: string;
  readonly recordId: string;
  readonly at: Date;
};

export type AccountSummary = {
  readonly username: string;
  readonly fullName: string;
  readonly role: Role;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly googleEmail: string | null;
};

/** Persistence for users, sessions and login failures (one adapter keeps multi-row changes atomic). */
export type IdentityStore = {
  hasUsers(): Promise<boolean>;
  findUser(username: string): Promise<StoredUser | null>;
  /** Returns false when the username already exists. */
  createUser(
    account: Omit<NewAccount, 'password'> & { passwordHash: string },
    at: Date,
  ): Promise<boolean>;
  listAccounts(): Promise<AccountSummary[]>;
  /** The account linked to a Google address, active or not (ADR 0010). */
  findUserByGoogleEmail(email: string): Promise<StoredUser | null>;
  /** Links (or with null unlinks) a Google address; ends the user's Google sessions on change. */
  setGoogleEmail(username: string, email: string | null): Promise<'set' | 'missing' | 'taken'>;
  /**
   * Links `email` to an administrator that has no Google address yet, in one statement: an
   * address already linked (or linked concurrently) is kept, and no session ends (ADR 0010).
   * `taken` means the administrator has no address and another account holds `email`.
   */
  linkBootstrapGoogleEmail(username: string, email: string): Promise<'linked' | 'kept' | 'taken'>;
  /** Atomically disables the user and deletes sessions; serializes the last-admin guard. */
  deactivateUser(username: string): Promise<'deactivated' | 'missing' | 'last_admin'>;
  updatePasswordHash(username: string, passwordHash: string): Promise<void>;
  /** Stores a new pending secret only while MFA is disabled; returns false otherwise. */
  startTotpEnrollment(username: string, sealedSecret: string): Promise<boolean>;
  /** Clears the second factor and deletes every session of the user, atomically (ADR 0009). */
  resetTotp(username: string): Promise<'reset' | 'missing'>;
  /**
   * Administrator path of resetTotp: refuses a user without a grant to `tenantId`, and in the
   * same transaction appends the audit row to that tenant's trail.
   */
  resetTotpInTenant(
    username: string,
    tenantId: string,
    audit: { readonly detail: string; readonly at: Date },
  ): Promise<'reset' | 'missing' | 'out_of_scope'>;
  /** Enables MFA, records the used step and revokes every other session of the user, atomically. */
  enableTotp(username: string, step: number, keepTokenHash: string): Promise<void>;
  /** Records a consumed step only if it is newer than the stored one; false means replay. */
  consumeTotpStep(username: string, step: number): Promise<boolean>;

  /**
   * False when deactivation won the race; holds a user-row lock through session insertion.
   * `viaGoogle` marks sessions opened by Google sign-in, which count as MFA (ADR 0010).
   */
  createSession(
    tokenHash: string,
    username: string,
    expiresAt: Date,
    at: Date,
    options?: { viaGoogle?: boolean },
  ): Promise<boolean>;
  findSessionIdentity(tokenHash: string, at: Date): Promise<SessionIdentity | null>;
  deleteSession(tokenHash: string): Promise<void>;
  /** The user's unexpired sessions, newest first (ties by hash, so every adapter agrees). */
  listSessions(username: string, at: Date): Promise<StoredSession[]>;
  /**
   * Deletes one session only if it belongs to `username` and, in the same transaction, appends
   * the audit row to `tenantId`'s trail. False when nothing was deleted (no audit row then).
   */
  endSession(
    username: string,
    tokenHash: string,
    tenantId: string,
    audit: SessionAudit & { readonly detail: string },
  ): Promise<boolean>;
  /**
   * Deletes every session of `username` still active at `at` except `keepTokenHash`, the ones
   * listSessions shows, and appends the audit row, whose detail depends on the count, atomically.
   * Expired rows are left to purgeExpiredSessions. No audit row when the count is 0. Returns the
   * count.
   */
  endOtherSessions(
    username: string,
    keepTokenHash: string,
    at: Date,
    tenantId: string,
    audit: SessionAudit & { readonly detail: (count: number) => string },
  ): Promise<number>;
  purgeExpiredSessions(at: Date): Promise<void>;

  /**
   * Atomically counts recent failures for both subjects and, when `decide` allows it, records
   * this attempt as a provisional failure. Serializing per subject makes concurrent bursts
   * consume the limit instead of all reading the same stale count. Rows at or before
   * `windowStart` are purged.
   */
  reserveLoginAttempt(input: {
    userSubject: string;
    ipSubject: string;
    windowStart: Date;
    at: Date;
    decide: (failures: { userFailures: number; ipFailures: number }) => ThrottleDecision;
  }): Promise<{ decision: ThrottleDecision; reservation: readonly number[] }>;
  /** Removes a provisional failure after the attempt succeeded. */
  releaseLoginAttempt(reservation: readonly number[]): Promise<void>;
  clearFailures(subject: string): Promise<void>;
};

export type PasswordHasher = {
  hash(password: string): Promise<string>;
  verify(password: string, stored: string): Promise<boolean>;
  needsRehash(stored: string): boolean;
};

export type TotpVerification =
  { readonly ok: true; readonly step: number } | { readonly ok: false };

export type TotpService = {
  generateSecret(): string;
  uri(username: string, secret: string): string;
  verify(secret: string, code: string, at: Date, lastStep: number | null): TotpVerification;
};

export type SecretCipher = {
  seal(plaintext: string): string;
  open(sealed: string): string;
};

export type SessionTokens = {
  /** 64 hex characters (32 random bytes), like app.py secrets.token_hex(32). */
  newToken(): string;
  hash(token: string): string;
  /**
   * The opaque id a session is shown and ended by: 32 hex characters derived one-way from the
   * stored hash, so it can neither sign in nor be matched to the hash column.
   */
  publicId(tokenHash: string): string;
};

export type Clock = { now(): Date };

/** Claims SIPGES needs from a Google ID token that was already validated (ADR 0010). */
export type GoogleProfile = { readonly email: string; readonly name: string };

export type GoogleAuthRequest = {
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
};

/** OpenID Connect authorization-code flow with Google, with PKCE. */
export type GoogleSignIn = {
  authorizationUrl(request: GoogleAuthRequest): string;
  /**
   * Exchanges the code and validates the ID token (issuer, audience, expiry, nonce and a
   * verified address). Null means the sign-in must be refused.
   */
  exchange(code: string, request: GoogleAuthRequest, at: Date): Promise<GoogleProfile | null>;
};

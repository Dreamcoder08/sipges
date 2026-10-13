import { type Result, err, ok } from '@mascli/kernel';
import { checkRoleAccess } from '../domain/access-policy.ts';
import { THROTTLE, ipSubject, throttleDecision, userSubject } from '../domain/login-throttle.ts';
import {
  type Identity,
  type SessionIdentity,
  PASSWORD_MIN,
  normalizeUsername,
  validateNewAccount,
} from '../domain/user.ts';
import type {
  AccountSummary,
  Clock,
  IdentityStore,
  PasswordHasher,
  SecretCipher,
  SessionTokens,
  TotpService,
} from './ports.ts';

export const SESSION_SECONDS = 8 * 3600;

export type LoginError =
  | { readonly kind: 'invalid_credentials' }
  | { readonly kind: 'invalid_otp' }
  | { readonly kind: 'throttled'; readonly retryAfterSeconds: number };

export type LoginSuccess = { readonly token: string; readonly identity: Identity };

export type IdentityDeps = {
  readonly store: IdentityStore;
  readonly hasher: PasswordHasher;
  readonly totp: TotpService;
  readonly cipher: SecretCipher;
  readonly tokens: SessionTokens;
  readonly clock: Clock;
};

export type BootstrapAdmin = {
  readonly username: string;
  readonly password: string;
  readonly fullName: string;
};

/** Upper bound enforced by the users table (migration 0001). */
const MAX_STORED_USERNAME = 120;

// Verifying against a real hash for unknown users keeps response timing uniform.
const DUMMY_HASH_INPUT = 'timing-equalizer-password';

export const createIdentityService = ({
  store,
  hasher,
  totp,
  cipher,
  tokens,
  clock,
}: IdentityDeps) => {
  // Computed eagerly so the first unknown-user login costs the same as later ones.
  const dummyHash = hasher.hash(DUMMY_HASH_INPUT);
  dummyHash.catch(() => undefined);
  const equalizeTiming = async (password: string) => {
    await hasher.verify(password, await dummyHash);
  };

  /** A sealed secret that cannot be opened (corruption, rotated key) fails the factor, never the request. */
  const openSecret = (sealed: string | null): string => {
    if (!sealed) return '';
    try {
      return cipher.open(sealed);
    } catch {
      console.error('Unreadable sealed TOTP secret; check MASCLI_DATA_KEY');
      return '';
    }
  };

  return {
    /** Creates the first admin on an empty installation (app.py init_auth_global). */
    async bootstrapAdmin(admin: BootstrapAdmin): Promise<void> {
      if (await store.hasUsers()) return;
      if (admin.password.length < PASSWORD_MIN) {
        throw new Error('Configure MASCLI_ADMIN_PASSWORD (mínimo 12 caracteres)');
      }
      await store.createUser(
        {
          username: admin.username,
          fullName: admin.fullName,
          role: 'admin',
          passwordHash: await hasher.hash(admin.password),
        },
        clock.now(),
      );
    },

    async login(input: {
      username: string;
      password: string;
      otp: string;
      ip: string;
    }): Promise<Result<LoginSuccess, LoginError>> {
      const now = clock.now();
      const username = normalizeUsername(input.username);
      // PostgreSQL text cannot hold NUL and stored names are at most 120 characters: such a
      // name cannot exist, so it is treated as an unknown user under a sanitized throttle key.
      const lookupable = !username.includes('\u0000') && username.length <= MAX_STORED_USERNAME;
      const userKey = userSubject(
        lookupable
          ? username
          : username.replaceAll('\u0000', '\uFFFD').slice(0, MAX_STORED_USERNAME),
      );
      // Reserve before verifying: the attempt counts as a failure unless it succeeds.
      const { decision, reservation } = await store.reserveLoginAttempt({
        userSubject: userKey,
        ipSubject: ipSubject(input.ip),
        windowStart: new Date(now.getTime() - THROTTLE.windowSeconds * 1000),
        at: now,
        decide: throttleDecision,
      });
      if (!decision.allowed) {
        return err({ kind: 'throttled', retryAfterSeconds: decision.retryAfterSeconds });
      }

      const user = lookupable ? await store.findUser(username) : null;
      if (!user) {
        await equalizeTiming(input.password);
        return err({ kind: 'invalid_credentials' });
      }
      if (!(await hasher.verify(input.password, user.passwordHash)) || !user.active) {
        return err({ kind: 'invalid_credentials' });
      }

      if (user.totpEnabled) {
        const check = totp.verify(
          openSecret(user.totpSecretSealed),
          input.otp,
          now,
          user.totpLastStep,
        );
        if (!check.ok || !(await store.consumeTotpStep(username, check.step))) {
          return err({ kind: 'invalid_otp' });
        }
      }

      if (hasher.needsRehash(user.passwordHash)) {
        await store.updatePasswordHash(username, await hasher.hash(input.password));
      }
      const token = tokens.newToken();
      const created = await store.createSession(
        tokens.hash(token),
        username,
        new Date(now.getTime() + SESSION_SECONDS * 1000),
        now,
      );
      if (!created) return err({ kind: 'invalid_credentials' });
      await store.releaseLoginAttempt(reservation);
      await store.clearFailures(userKey);
      await store.purgeExpiredSessions(now);
      return ok({ token, identity: { username, fullName: user.fullName, role: user.role } });
    },

    async authenticate(token: string | undefined): Promise<SessionIdentity | null> {
      if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
      return store.findSessionIdentity(tokens.hash(token), clock.now());
    },

    async logout(token: string | undefined): Promise<void> {
      if (token) await store.deleteSession(tokens.hash(token));
    },

    checkAccess: checkRoleAccess,

    async createAccount(input: {
      username: string;
      fullName: string;
      password: string;
      role: string;
    }): Promise<Result<Identity, { kind: 'invalid'; detail: string } | { kind: 'exists' }>> {
      const valid = validateNewAccount(input);
      if (!valid.ok) return err({ kind: 'invalid', detail: valid.error });
      const { password, ...account } = valid.value;
      const created = await store.createUser(
        { ...account, passwordHash: await hasher.hash(password) },
        clock.now(),
      );
      return created ? ok(account) : err({ kind: 'exists' });
    },

    async deactivateAccount(
      actor: Identity,
      rawUsername: string,
    ): Promise<Result<true, 'forbidden' | 'invalid' | 'missing' | 'last_admin'>> {
      if (actor.role !== 'admin') return err('forbidden');
      const username = normalizeUsername(rawUsername);
      if (!username || username.includes('\u0000') || username.length > MAX_STORED_USERNAME)
        return err('invalid');
      const result = await store.deactivateUser(username);
      return result === 'deactivated' ? ok(true) : err(result);
    },

    /**
     * Lets an administrator clear another account's second factor (lost authenticator). The
     * user's sessions end and the next login enrolls again. An administrator cannot reset
     * their own MFA: a stolen admin session must not be able to remove the factor (ADR 0009).
     */
    async resetMfa(
      actor: Identity,
      rawUsername: string,
    ): Promise<Result<true, 'forbidden' | 'self' | 'invalid' | 'missing'>> {
      if (actor.role !== 'admin') return err('forbidden');
      const username = normalizeUsername(rawUsername);
      if (!username || username.includes('\u0000') || username.length > MAX_STORED_USERNAME)
        return err('invalid');
      if (username === actor.username) return err('self');
      const result = await store.resetTotp(username);
      return result === 'reset' ? ok(true) : err(result);
    },

    async userExists(username: string): Promise<boolean> {
      return (await store.findUser(username)) !== null;
    },

    listAccounts(): Promise<AccountSummary[]> {
      return store.listAccounts();
    },

    async setupTotp(
      username: string,
    ): Promise<Result<{ secret: string; uri: string }, 'already_enabled'>> {
      const secret = totp.generateSecret();
      const started = await store.startTotpEnrollment(username, cipher.seal(secret));
      return started ? ok({ secret, uri: totp.uri(username, secret) }) : err('already_enabled');
    },

    async enableTotp(
      username: string,
      code: string,
      currentToken: string,
    ): Promise<Result<true, 'invalid_code'>> {
      const user = await store.findUser(username);
      if (!user) return err('invalid_code');
      const check = totp.verify(
        openSecret(user.totpSecretSealed),
        code,
        clock.now(),
        user.totpLastStep,
      );
      if (!check.ok) return err('invalid_code');
      await store.enableTotp(username, check.step, tokens.hash(currentToken));
      return ok(true);
    },
  };
};

export type IdentityService = ReturnType<typeof createIdentityService>;

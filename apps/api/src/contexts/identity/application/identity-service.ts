import { type Result, err, ok } from '@mascli/kernel';
import { checkRoleAccess } from '../domain/access-policy.ts';
import { THROTTLE, ipSubject, throttleDecision, userSubject } from '../domain/login-throttle.ts';
import {
  type Identity,
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
  let dummyHash: Promise<string> | undefined;
  const equalizeTiming = async (password: string) => {
    dummyHash ??= hasher.hash(DUMMY_HASH_INPUT);
    await hasher.verify(password, await dummyHash);
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
      const subjects = [userSubject(username), ipSubject(input.ip)] as const;
      const since = new Date(now.getTime() - THROTTLE.windowSeconds * 1000);
      const decision = throttleDecision({
        userFailures: await store.countFailures(subjects[0], since),
        ipFailures: await store.countFailures(subjects[1], since),
      });
      if (!decision.allowed) {
        return err({ kind: 'throttled', retryAfterSeconds: decision.retryAfterSeconds });
      }

      const fail = async (error: LoginError) => {
        await store.recordFailures(subjects, now);
        return err(error);
      };

      const user = await store.findUser(username);
      if (!user) {
        await equalizeTiming(input.password);
        return fail({ kind: 'invalid_credentials' });
      }
      if (!(await hasher.verify(input.password, user.passwordHash)) || !user.active) {
        return fail({ kind: 'invalid_credentials' });
      }

      if (user.totpEnabled) {
        const secret = user.totpSecretSealed ? cipher.open(user.totpSecretSealed) : '';
        const check = totp.verify(secret, input.otp, now, user.totpLastStep);
        if (!check.ok || !(await store.consumeTotpStep(username, check.step))) {
          return fail({ kind: 'invalid_otp' });
        }
      }

      if (hasher.needsRehash(user.passwordHash)) {
        await store.updatePasswordHash(username, await hasher.hash(input.password));
      }
      await store.clearFailures(subjects[0]);
      await store.purgeExpiredSessions(now);

      const token = tokens.newToken();
      await store.createSession(
        tokens.hash(token),
        username,
        new Date(now.getTime() + SESSION_SECONDS * 1000),
        now,
      );
      return ok({ token, identity: { username, fullName: user.fullName, role: user.role } });
    },

    async authenticate(token: string | undefined): Promise<Identity | null> {
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
      if (!user?.totpSecretSealed) return err('invalid_code');
      const check = totp.verify(
        cipher.open(user.totpSecretSealed),
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

import type { ParityCase } from '../types.ts';

/**
 * The identity context beyond the session gates (T35). The hashes below are of the throwaway
 * `parity-login-password`, written by the TypeScript hashers. Failed logins on this run share
 * one address and its limit of 20: both APIs count, so each refused case costs two. The
 * throttled user starts with 5 recorded failures instead of spending that budget.
 */
const PASSWORD = 'parity-login-password';
const ARGON2 =
  '$argon2id$v=19$m=19456,t=2,p=1$XWhMDD1+YGVgy/UJq6b4tw$fql+Oq+08BZDbf9L8uZ8g8L7n769QzOQDGeK3uha/zQ';
const LEGACY =
  'pbkdf2_sha256$1000$0a1b2c3d4e5f60718293a4b5c6d7e8f9$a041f11d5a9a47a32a2ee6eaad0755e28ce8707a08721afd892f7bdb085860e6';

export const seed = `
INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
  ('parity-login', 'Paridad Ñandú', '${ARGON2}', 'analista', true, false),
  ('parity-login-inactive', 'Paridad', '${ARGON2}', 'analista', false, false),
  ('parity-login-throttled', 'Paridad', '${ARGON2}', 'analista', true, false),
  ('parity-legacy-ts', 'Paridad', '${LEGACY}', 'analista', true, false),
  ('parity-legacy-go', 'Paridad', '${LEGACY}', 'analista', true, false);
INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled, totp_secret_sealed)
  VALUES ('parity-login-mfa', 'Paridad', '${ARGON2}', 'analista', true, true, 'v1.AAAA');
INSERT INTO login_failures (subject, failed_at)
  SELECT 'user:parity-login-throttled', now() FROM generate_series(1, 5);
`;

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const BOUNDARY = 'parityBoundary0123';
const multipart = (fields: Readonly<Record<string, string>>) =>
  `${Object.entries(fields)
    .map(
      ([name, value]) =>
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    )
    .join('')}--${BOUNDARY}--\r\n`;

const login = (name: string, extra: Omit<ParityCase, 'name' | 'method' | 'path'>): ParityCase => ({
  name: `identity: login ${name}`,
  method: 'POST',
  path: '/login',
  sameOrigin: true,
  ...extra,
});
const credentials = (username: string, password = PASSWORD) => ({
  body: { form: { username, password } },
});

const enable = (name: string, body: ParityCase['body'], auth?: 'admin'): ParityCase => ({
  name: `identity: TOTP enable ${name}`,
  method: 'POST',
  path: '/system/auth/totp/enable',
  sameOrigin: true,
  ...(body ? { body } : {}),
  ...(auth ? { auth } : {}),
});
const totp: readonly ParityCase[] = [
  {
    // The parity administrator has no second factor: this only leaves a pending secret.
    name: 'identity: TOTP setup',
    method: 'POST',
    path: '/system/auth/totp/setup',
    sameOrigin: true,
    auth: 'admin',
    normalize: ['secret', 'otpauth_uri'],
  },
  {
    name: 'identity: TOTP setup without a session',
    method: 'POST',
    path: '/system/auth/totp/setup',
    sameOrigin: true,
  },
  {
    name: 'identity: TOTP setup without Origin',
    method: 'POST',
    path: '/system/auth/totp/setup',
    auth: 'admin',
  },
  {
    name: 'identity: GET TOTP setup',
    method: 'GET',
    path: '/system/auth/totp/setup',
    auth: 'admin',
  },
  enable('without a session', { json: { code: '123456' } }),
  enable('malformed code', { json: { code: 'abc' } }, 'admin'),
  enable('code as a number', { json: { code: 123456 } }, 'admin'),
  enable('no code', { json: {} }, 'admin'),
  enable('array body', { json: [] }, 'admin'),
  enable('invalid JSON', { raw: '{' }, 'admin'),
  enable('no body', undefined, 'admin'),
];

export const cases: readonly ParityCase[] = [
  login('with an argon2id hash', credentials('parity-login')),
  login('with spaces and upper case in the name', credentials('  PARITY-Login\t')),
  login('last value of a repeated field wins', {
    headers: FORM,
    body: { raw: `username=nobody&username=parity-login&password=${PASSWORD}` },
  }),
  login('as multipart', {
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    body: { raw: multipart({ username: 'parity-login', password: PASSWORD }) },
  }),
  // Each API replaces its own legacy hash, then verifies the one the other API wrote.
  login('with a legacy hash rewrites it', {
    vary: { user: { ts: 'parity-legacy-ts', go: 'parity-legacy-go' } },
    ...credentials('{user}'),
  }),
  login('with the hash the other API rewrote', {
    vary: { user: { ts: 'parity-legacy-go', go: 'parity-legacy-ts' } },
    ...credentials('{user}'),
  }),

  login('wrong password', credentials('parity-login', 'not-the-password')),
  login('unknown user', credentials('parity-nobody')),
  login('inactive account', credentials('parity-login-inactive')),
  login('NUL in the name', credentials('parity-login\u0000')),
  login('name over 120 characters', credentials('a'.repeat(121))),
  login('throttled user, right password', credentials('parity-login-throttled')),

  login('no body', {}),
  login('no password', { body: { form: { username: 'parity-login' } } }),
  login('json body', { body: { json: { username: 'parity-login', password: PASSWORD } } }),
  login('undecodable multipart', {
    headers: { 'content-type': 'multipart/form-data' },
    body: { raw: 'x' },
  }),
  {
    name: 'identity: login without Origin',
    method: 'POST',
    path: '/login',
    ...credentials('parity-login'),
  },
  // A sealed secret that cannot be opened fails the factor. A right code needs a secret sealed
  // with the run's key: apps/api-go/internal/app/identity_totp_integration_test.go proves it.
  login('second factor missing', credentials('parity-login-mfa')),
  login('second factor unreadable', {
    body: { form: { username: 'parity-login-mfa', password: PASSWORD, otp: '123456' } },
  }),
  ...totp,
  { name: 'identity: GET /login', method: 'GET', path: '/login' },
  {
    name: 'identity: POST /login/ without a session',
    method: 'POST',
    path: '/login/',
    sameOrigin: true,
  },
];

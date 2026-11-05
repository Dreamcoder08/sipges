import { createHash } from 'node:crypto';
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

/** Synthetic session tokens, one per API: each logout ends its own session. */
const LOGOUT_TOKEN = { ts: '1'.repeat(64), go: '2'.repeat(64) };
const hashed = (token: string) => createHash('sha256').update(token).digest('hex');

export const seed = `
INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
  ('parity-login', 'Paridad Ñandú', '${ARGON2}', 'analista', true, false),
  ('parity-login-inactive', 'Paridad', '${ARGON2}', 'analista', false, false),
  ('parity-login-throttled', 'Paridad', '${ARGON2}', 'analista', true, false),
  ('parity-legacy-ts', 'Paridad', '${LEGACY}', 'analista', true, false),
  ('parity-legacy-go', 'Paridad', '${LEGACY}', 'analista', true, false);
INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled, totp_secret_sealed)
  VALUES ('parity-login-mfa', 'Paridad', '${ARGON2}', 'analista', true, true, 'v1.AAAA');
INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled, totp_secret_sealed, totp_last_step) VALUES
  ('parity-off-ts', 'Paridad', 'x', 'analista', true, true, NULL, NULL),
  ('parity-off-go', 'Paridad', 'x', 'analista', true, true, NULL, NULL),
  ('parity-reset-ts', 'Paridad', 'x', 'analista', true, true, 'v1.AAAA', 7),
  ('parity-reset-go', 'Paridad', 'x', 'analista', true, true, 'v1.AAAA', 7),
  ('parity-foreign', 'Paridad', 'x', 'analista', true, true, 'v1.AAAA', 7);
INSERT INTO grants (username, tenant_id) VALUES
  ('parity-reset-ts', 'SIPGES/PRJ-SECHURA'),
  ('parity-reset-go', 'SIPGES/PRJ-SECHURA'),
  ('parity-foreign', 'PARITY/OTRO');
INSERT INTO sessions (token_hash, username, expires_at) VALUES
  ('${hashed(LOGOUT_TOKEN.ts)}', 'parity-login', now() + interval '1 hour'),
  ('${hashed(LOGOUT_TOKEN.go)}', 'parity-login', now() + interval '1 hour');
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

const ACCOUNTS = '/system/auth/accounts';
const account = (
  name: string,
  path: string,
  extra: Omit<ParityCase, 'name' | 'method' | 'path'>,
  method: ParityCase['method'] = 'POST',
): ParityCase => ({
  name: `identity: ${name}`,
  method,
  path,
  auth: 'admin',
  ...(method === 'POST' ? { sameOrigin: true as const } : {}),
  ...extra,
});
const off = { user: { ts: 'parity-off-ts', go: 'parity-off-go' } };
const reset = { user: { ts: 'parity-reset-ts', go: 'parity-reset-go' } };
const created = { user: { ts: 'parity.new.ts', go: 'parity.new.go' } };
const logoutCookie = { cookie: 'sipges_session={token}' };
const logoutToken = { token: LOGOUT_TOKEN };
const accounts: readonly ParityCase[] = [
  account('accounts list', ACCOUNTS, {}, 'GET'),
  account('accounts list as consulta', ACCOUNTS, { auth: 'consulta' }, 'GET'),
  { name: 'identity: accounts list without a session', method: 'GET', path: ACCOUNTS },
  account('create account', ACCOUNTS, {
    vary: created,
    normalize: ['username'],
    body: {
      json: { username: '{user}', full_name: 'Ñandú', password: PASSWORD, role: 'analista' },
    },
  }),
  account('create account again', ACCOUNTS, {
    vary: created,
    body: { json: { username: '{user}', full_name: 'Ñandú', password: PASSWORD } },
  }),
  account('the created account signs in', '/login', {
    vary: created,
    body: { form: { username: '{user}', password: PASSWORD } },
  }),
  account('created accounts are listed', ACCOUNTS, {}, 'GET'),
  account('create with the default role', ACCOUNTS, {
    vary: { user: { ts: 'parity.def.ts', go: 'parity.def.go' } },
    normalize: ['username'],
    body: { json: { username: '{user}', full_name: 'x'.repeat(130), password: PASSWORD } },
  }),
  account('create: invalid username', ACCOUNTS, {
    body: { json: { username: 'Ana', full_name: 'x', password: PASSWORD } },
  }),
  account('create: unknown role', ACCOUNTS, {
    body: { json: { username: 'parity.role', full_name: 'x', password: PASSWORD, role: 'root' } },
  }),
  account('create: short password', ACCOUNTS, {
    body: { json: { username: 'parity.short', full_name: 'x', password: 'short' } },
  }),
  account('create: long password', ACCOUNTS, {
    body: { json: { username: 'parity.long', full_name: 'x', password: 'x'.repeat(257) } },
  }),
  account('create: missing fields', ACCOUNTS, { body: { json: { role: null } } }),
  account('create: invalid JSON', ACCOUNTS, { body: { raw: '{' } }),
  account('create as consulta', ACCOUNTS, {
    auth: 'consulta',
    body: { json: { username: 'parity.denied', full_name: 'x', password: PASSWORD } },
  }),

  account('deactivate', `${ACCOUNTS}/{user}/deactivate`, { vary: off }),
  account('deactivate again', `${ACCOUNTS}/{user}/deactivate`, { vary: off }),
  account('deactivate in upper case', `${ACCOUNTS}/PARITY-LOGIN-INACTIVE/deactivate`, {}),
  account('deactivate a missing user', `${ACCOUNTS}/parity-nobody/deactivate`, {}),
  account('deactivate a blank name', `${ACCOUNTS}/%20/deactivate`, {}),
  account('deactivate a NUL name', `${ACCOUNTS}/%00/deactivate`, {}),
  account('deactivate as consulta', `${ACCOUNTS}/parity-login/deactivate`, { auth: 'consulta' }),
  {
    name: 'identity: deactivate without Origin',
    method: 'POST',
    path: `${ACCOUNTS}/parity-login/deactivate`,
    auth: 'admin',
  },

  account('reset MFA of oneself', `${ACCOUNTS}/parity-admin/reset-mfa`, {}),
  account('reset MFA of another project', `${ACCOUNTS}/parity-foreign/reset-mfa`, {}),
  account('reset MFA of a missing user', `${ACCOUNTS}/parity-nobody/reset-mfa`, {}),
  account('reset MFA of a NUL name', `${ACCOUNTS}/%00/reset-mfa`, {}),
  account('reset MFA', `${ACCOUNTS}/{user}/reset-mfa`, {
    vary: reset,
    normalize: ['username'],
  }),
  account('reset MFA in upper case repeated', `${ACCOUNTS}/PARITY-RESET-TS/reset-mfa`, {}),
  account('reset MFA with a project in the query', `${ACCOUNTS}/{user}/reset-mfa?project_id=OTRO`, {
    vary: reset,
  }),
  account('audit shows the resets', '/system/audit?limit=50', { normalize: ['*.ts'] }, 'GET'),

  {
    name: 'identity: logout without a session',
    method: 'POST',
    path: '/logout',
    sameOrigin: true,
  },
  { name: 'identity: logout without Origin', method: 'POST', path: '/logout' },
  {
    name: 'identity: logout of an unknown session',
    method: 'POST',
    path: '/logout',
    sameOrigin: true,
    headers: { cookie: `sipges_session=${'3'.repeat(64)}` },
  },
  {
    name: 'identity: the session is open before logout',
    method: 'GET',
    path: '/system/auth/me',
    vary: logoutToken,
    headers: logoutCookie,
  },
  {
    name: 'identity: logout',
    method: 'POST',
    path: '/logout',
    sameOrigin: true,
    vary: logoutToken,
    headers: logoutCookie,
  },
  {
    name: 'identity: the session is closed after logout',
    method: 'GET',
    path: '/system/auth/me',
    vary: logoutToken,
    headers: logoutCookie,
  },
];

const API_KEYS = '/system/integrations/api-keys';
const issue = (
  name: string,
  body: NonNullable<ParityCase['body']>,
  extra: Partial<ParityCase> = {},
) => account(`API key ${name}`, API_KEYS, { body, ...extra });
const keyNames = { key: { ts: 'parity key ts', go: 'parity key go' } };
const apiKeys: readonly ParityCase[] = [
  issue(
    'issued',
    { json: { name: '  {key}  ', access: 'write', clearance: 'full' } },
    { vary: keyNames, normalize: ['id', 'token'] },
  ),
  issue(
    'with defaults',
    { json: { name: '{key} default' } },
    {
      vary: keyNames,
      normalize: ['id', 'token'],
    },
  ),
  issue('with the same name', { json: { name: ' {key} ' } }, { vary: keyNames }),
  issue('without a name', { json: {} }),
  issue('with an empty name', { json: { name: '   ' } }),
  issue('with a long name', { json: { name: 'x'.repeat(81) } }),
  issue('with NUL in the name', { json: { name: 'a\u0000' } }),
  issue(
    'with a lone surrogate at the limit',
    { raw: `{"name":"{key}${'x'.repeat(66)}\\ud83d"}` },
    {
      vary: keyNames,
      normalize: ['id', 'token'],
    },
  ),
  issue('with a number as name', { json: { name: 1 } }),
  issue('with an unknown access', { json: { name: 'x', access: 'all', clearance: 'none' } }),
  issue('with a null access', { json: { name: 'x', access: null } }),
  issue('with an array body', { json: [] }),
  issue('with invalid JSON', { raw: '{' }),
  issue('as consulta', { json: { name: 'x' } }, { auth: 'consulta' }),
  issue('in an ungranted project', { json: { name: 'x', project_id: 'OTRO' } }),
  {
    name: 'identity: API key without a session',
    method: 'POST',
    path: API_KEYS,
    sameOrigin: true,
    body: { json: { name: 'x' } },
  },
  {
    name: 'identity: API key without Origin',
    method: 'POST',
    path: API_KEYS,
    auth: 'admin',
    body: { json: { name: 'x' } },
  },
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
  ...accounts,
  ...apiKeys,
  { name: 'identity: GET /login', method: 'GET', path: '/login' },
  {
    name: 'identity: POST /login/ without a session',
    method: 'POST',
    path: '/login/',
    sameOrigin: true,
  },
];

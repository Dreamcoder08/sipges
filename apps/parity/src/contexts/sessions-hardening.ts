import { createHash } from 'node:crypto';
import type { ParityCase } from '../types.ts';

/**
 * Regression cases from the independent review of the Cuenta session routes (sessions.ts):
 * foreign, unknown and malformed ids all answer the same 404; every Origin refusal ends nothing;
 * an account with no project is refused while /logout still works; a read-only account reaches
 * nothing but its own sessions; «cerrar sesión en todos los demás» counts only active sessions
 * and writes no audit row when it ended none. Every account and token below is synthetic.
 */
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** session-tokens.ts publicId, so a case can name a seeded session by its opaque id. */
const idOf = (token: string) => sha256(`sipges-session-id:${sha256(token)}`).slice(0, 32);
/** 64 hex characters, distinct from every other context's tokens. */
const token = (pair: string) => pair.repeat(32);

const T = {
  list: token('d4'),
  listOther: token('d5'),
  listExpired: token('d6'),
  foreign: token('d7'),
  noGrantTs: token('d8'),
  noGrantGo: token('d9'),
  reader: token('da'),
  readerOther: token('db'),
  zeroTs: token('dc'),
  zeroGo: token('dd'),
  expiredTs: token('de'),
  expiredTsActive: token('df'),
  expiredTsGone: token('e0'),
  expiredGo: token('e1'),
  expiredGoActive: token('e2'),
  expiredGoGone: token('e3'),
} as const;

const SCOPE = 'SIPGES/PRJ-SECHURA';
const USER = {
  list: 'parity-hardening-list',
  foreign: 'parity-hardening-foreign',
  noGrantTs: 'parity-hardening-nogrant-ts',
  noGrantGo: 'parity-hardening-nogrant-go',
  reader: 'parity-hardening-reader',
  zeroTs: 'parity-hardening-zero-ts',
  zeroGo: 'parity-hardening-zero-go',
  expiredTs: 'parity-hardening-expired-ts',
  expiredGo: 'parity-hardening-expired-go',
} as const;

/** [user, role, granted the default project] */
const USERS: readonly (readonly [string, string, boolean])[] = [
  [USER.list, 'analista', true],
  [USER.foreign, 'analista', true],
  [USER.noGrantTs, 'analista', false],
  [USER.noGrantGo, 'analista', false],
  [USER.reader, 'consulta', true],
  [USER.zeroTs, 'consulta', true],
  [USER.zeroGo, 'consulta', true],
  [USER.expiredTs, 'coordinador', true],
  [USER.expiredGo, 'coordinador', true],
];

const FUTURE = '2099-01-01T00:00:00Z';
const PAST = '2026-01-01T08:00:00Z';

/** [token, user, created at, expires at]: the `*Gone` and `listExpired` rows are expired, unpurged. */
const SESSIONS: readonly (readonly [string, string, string, string])[] = [
  [T.list, USER.list, '2026-11-02T10:00:00Z', FUTURE],
  [T.listOther, USER.list, '2026-11-02T10:01:00Z', FUTURE],
  [T.listExpired, USER.list, '2026-01-01T00:00:00Z', PAST],
  [T.foreign, USER.foreign, '2026-11-02T10:02:00Z', FUTURE],
  [T.noGrantTs, USER.noGrantTs, '2026-11-02T10:00:00Z', FUTURE],
  [T.noGrantGo, USER.noGrantGo, '2026-11-02T10:00:00Z', FUTURE],
  [T.reader, USER.reader, '2026-11-02T10:00:00Z', FUTURE],
  [T.readerOther, USER.reader, '2026-11-02T10:01:00Z', FUTURE],
  [T.zeroTs, USER.zeroTs, '2026-11-02T10:00:00Z', FUTURE],
  [T.zeroGo, USER.zeroGo, '2026-11-02T10:00:00Z', FUTURE],
  [T.expiredTs, USER.expiredTs, '2026-11-02T10:00:00Z', FUTURE],
  [T.expiredTsActive, USER.expiredTs, '2026-11-02T10:01:00Z', FUTURE],
  [T.expiredTsGone, USER.expiredTs, '2026-01-01T00:00:00Z', PAST],
  [T.expiredGo, USER.expiredGo, '2026-11-02T10:00:00Z', FUTURE],
  [T.expiredGoActive, USER.expiredGo, '2026-11-02T10:01:00Z', FUTURE],
  [T.expiredGoGone, USER.expiredGo, '2026-01-01T00:00:00Z', PAST],
];

export const seed = `
INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
${USERS.map(([user, role]) => `  ('${user}', 'Paridad Revisión', 'x', '${role}', true, true)`).join(',\n')};
INSERT INTO grants (username, tenant_id) VALUES
${USERS.filter(([, , granted]) => granted)
  .map(([user]) => `  ('${user}', '${SCOPE}')`)
  .join(',\n')};
INSERT INTO sessions (token_hash, username, expires_at, created_at, via_google) VALUES
${SESSIONS.map(
  ([t, user, created, expires]) =>
    `  ('${sha256(t)}', '${user}', '${expires}', '${created}', false)`,
).join(',\n')};
`;

const SESSIONS_PATH = '/system/auth/sessions';
const REVOKE = `${SESSIONS_PATH}/revoke-others`;
const cookie = (t: string) => ({ cookie: `sipges_session=${t}` });
/** No answer may carry a token or its stored hash. */
const secretFree = Object.values(T).flatMap((t) => [t, sha256(t)]);

const perApi = (
  ts: Record<string, string>,
  go: Record<string, string>,
): NonNullable<ParityCase['vary']> =>
  Object.fromEntries(Object.keys(ts).map((k) => [k, { ts: ts[k] ?? '', go: go[k] ?? '' }]));

const varied = { cookie: 'sipges_session={cur}' };
const noGrant = perApi({ cur: T.noGrantTs }, { cur: T.noGrantGo });
const zero = perApi({ cur: T.zeroTs }, { cur: T.zeroGo });
const expired = perApi(
  { cur: T.expiredTs, other: T.expiredTsActive },
  { cur: T.expiredGo, other: T.expiredGoActive },
);

const readerId = idOf(T.readerOther);

/** Writes a browser on another site, or no browser, would send: none carries this API's Origin. */
const ORIGIN_REFUSALS: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
  ['without Origin', {}],
  ['with Origin: null', { origin: 'null' }],
  ['with a cross-site Origin', { origin: 'https://evil.example' }],
  ['with a cross-site Referer', { referer: 'https://evil.example/cuenta' }],
];

export const cases: readonly ParityCase[] = [
  // The list: exactly the five fields, own active sessions only.
  {
    name: 'sessions-hardening: list holds only own active sessions',
    method: 'GET',
    path: SESSIONS_PATH,
    headers: cookie(T.list),
    present: [idOf(T.list), idOf(T.listOther), '"current":true', '"method":"password"'],
    absent: [idOf(T.foreign), idOf(T.listExpired), ...secretFree],
  },

  // Every id that is not one of the caller's active sessions answers the same 404.
  ...[
    ['of another user', idOf(T.foreign)],
    ['of an expired, unpurged session', idOf(T.listExpired)],
    ['of an unknown id', 'f'.repeat(32)],
    ['of 31 hex characters', idOf(T.listOther).slice(0, 31)],
    ['of 33 hex characters', `${idOf(T.listOther)}0`],
    ['of an upper-case id', idOf(T.listOther).toUpperCase()],
    ['of 32 non-hex characters', 'g'.repeat(32)],
    ['by the first half of its token', T.listOther.slice(0, 32)],
    ['by the first half of its stored hash', sha256(T.listOther).slice(0, 32)],
    ['by an encoded slash', 'a%2Fb'],
  ].map(([what, id]): ParityCase => ({
    name: `sessions-hardening: end ${what}`,
    method: 'DELETE',
    path: `${SESSIONS_PATH}/${id}`,
    headers: cookie(T.list),
    sameOrigin: true,
    absent: secretFree,
  })),
  {
    name: "sessions-hardening: another user's session still works",
    method: 'GET',
    path: '/system/auth/me',
    headers: cookie(T.foreign),
    present: [USER.foreign],
  },

  // Origin refusals: 403 for both writes, nothing ended.
  ...ORIGIN_REFUSALS.flatMap(([what, headers]): ParityCase[] => [
    {
      name: `sessions-hardening: end ${what}`,
      method: 'DELETE',
      path: `${SESSIONS_PATH}/${idOf(T.listOther)}`,
      headers: { ...cookie(T.list), ...headers },
      present: ['Origen de solicitud no permitido'],
    },
    {
      name: `sessions-hardening: revoke others ${what}`,
      method: 'POST',
      path: REVOKE,
      headers: { ...cookie(T.list), ...headers },
      present: ['Origen de solicitud no permitido'],
    },
  ]),
  {
    name: 'sessions-hardening: the refused writes ended nothing',
    method: 'GET',
    path: SESSIONS_PATH,
    headers: cookie(T.listOther),
    present: [idOf(T.list), idOf(T.listOther)],
  },

  // An account with no project grant: refused on all three, /logout still works.
  {
    name: 'sessions-hardening: list with no project',
    method: 'GET',
    path: SESSIONS_PATH,
    headers: varied,
    vary: noGrant,
    present: ['Seleccione un proyecto autorizado'],
  },
  {
    name: 'sessions-hardening: end with no project',
    method: 'DELETE',
    path: `${SESSIONS_PATH}/${'f'.repeat(32)}`,
    headers: varied,
    vary: noGrant,
    sameOrigin: true,
    present: ['Seleccione un proyecto autorizado'],
  },
  {
    name: 'sessions-hardening: revoke others with no project',
    method: 'POST',
    path: REVOKE,
    headers: varied,
    vary: noGrant,
    sameOrigin: true,
    present: ['Seleccione un proyecto autorizado'],
  },
  {
    name: 'sessions-hardening: logout with no project',
    method: 'POST',
    path: '/logout',
    headers: varied,
    vary: noGrant,
    sameOrigin: true,
    present: ['"ok":true'],
  },
  {
    name: 'sessions-hardening: the session is closed after logout with no project',
    method: 'GET',
    path: '/system/auth/me',
    headers: varied,
    vary: noGrant,
    present: ['null'],
  },

  // A read-only account: anything but exactly its own session is a role refusal.
  ...(
    [
      ['DELETE', `${SESSIONS_PATH}/`, false],
      ['DELETE', `${SESSIONS_PATH}/${readerId}/`, false],
      ['DELETE', `${SESSIONS_PATH}/${readerId}/extra`, false],
      ['DELETE', `${SESSIONS_PATH}//${readerId}`, true],
      ['DELETE', `${SESSIONS_PATH}/%2e%2e`, true],
      ['DELETE', `${SESSIONS_PATH}/${readerId}/..`, true],
      ['DELETE', `${SESSIONS_PATH}/../accounts`, true],
      ['POST', `${SESSIONS_PATH}/${readerId}`, false],
      ['PUT', `${SESSIONS_PATH}/${readerId}`, false],
      ['POST', `${REVOKE}/`, false],
    ] as const
  ).map(([method, path, raw]): ParityCase => ({
    name: `sessions-hardening: consulta ${method} ${path.replace(readerId, ':id')}`,
    method,
    path,
    headers: cookie(T.reader),
    sameOrigin: true,
    ...(raw ? { rawTarget: true as const } : {}),
  })),
  {
    name: 'sessions-hardening: the read-only account kept both sessions',
    method: 'GET',
    path: SESSIONS_PATH,
    headers: cookie(T.readerOther),
    present: [idOf(T.reader), readerId],
  },

  // «Cerrar sesión en todos los demás»: none to end writes no audit row.
  {
    name: 'sessions-hardening: revoke others with none open',
    method: 'POST',
    path: REVOKE,
    headers: varied,
    vary: zero,
    sameOrigin: true,
    present: ['"count":0'],
  },
  {
    name: 'sessions-hardening: revoke others with none open, again',
    method: 'POST',
    path: REVOKE,
    headers: varied,
    vary: zero,
    sameOrigin: true,
    present: ['"count":0'],
  },
  // An expired, unpurged session is neither ended nor counted.
  {
    name: 'sessions-hardening: revoke others counts only active sessions',
    method: 'POST',
    path: REVOKE,
    headers: varied,
    vary: expired,
    sameOrigin: true,
    present: ['"count":1'],
  },
  {
    name: 'sessions-hardening: the revoked active session is closed',
    method: 'GET',
    path: '/system/auth/me',
    headers: { cookie: 'sipges_session={other}' },
    vary: expired,
    present: ['null'],
  },
  {
    name: 'sessions-hardening: the audit trail holds no empty revocation',
    method: 'GET',
    path: '/system/audit?limit=100',
    auth: 'admin',
    normalize: ['*.ts'],
    present: [
      `1 sesión cerrada en otros dispositivos por ${USER.expiredTs}`,
      `1 sesión cerrada en otros dispositivos por ${USER.expiredGo}`,
    ],
    absent: [USER.zeroTs, USER.zeroGo, USER.reader, USER.list, USER.noGrantTs, ...secretFree],
  },
];

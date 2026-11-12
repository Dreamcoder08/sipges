import { createHash } from 'node:crypto';
import type { ParityCase } from '../types.ts';

/**
 * Cuenta: one's own active sessions (GET /system/auth/sessions), ending one
 * (DELETE /system/auth/sessions/:id) and «cerrar sesión en todos los demás»
 * (POST /system/auth/sessions/revoke-others). Every account and token below is synthetic; each
 * write ends sessions of an account of its own per API, so the two APIs never race for a row.
 */
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** session-tokens.ts publicId, so a case can name a seeded session by its opaque id. */
const idOf = (token: string) => sha256(`sipges-session-id:${sha256(token)}`).slice(0, 32);
/** 64 hex characters, distinct from every other context's tokens. */
const token = (pair: string) => pair.repeat(32);

const T = {
  list1: token('c0'),
  list2: token('c1'),
  listExpired: token('c2'),
  other: token('c3'),
  endTs: token('c4'),
  endTsOther: token('c5'),
  endGo: token('c6'),
  endGoOther: token('c7'),
  selfTs: token('c8'),
  selfGo: token('c9'),
  revokeTs: token('ca'),
  revokeTsA: token('cb'),
  revokeTsB: token('cc'),
  revokeGo: token('cd'),
  revokeGoA: token('ce'),
  revokeGoB: token('cf'),
  readerTs: token('d0'),
  readerTsOther: token('d1'),
  readerGo: token('d2'),
  readerGoOther: token('d3'),
} as const;

const SCOPE = 'SIPGES/PRJ-SECHURA';
const USERS = [
  ['parity-sessions-list', 'analista'],
  ['parity-sessions-other', 'analista'],
  ['parity-sessions-end-ts', 'analista'],
  ['parity-sessions-end-go', 'analista'],
  ['parity-sessions-self-ts', 'analista'],
  ['parity-sessions-self-go', 'analista'],
  ['parity-sessions-revoke-ts', 'coordinador'],
  ['parity-sessions-revoke-go', 'coordinador'],
  ['parity-sessions-reader-ts', 'consulta'],
  ['parity-sessions-reader-go', 'consulta'],
] as const;

/** [token, user, created at, Google] — all expire far in the future except `listExpired`. */
const SESSIONS: readonly (readonly [string, string, string, boolean])[] = [
  [T.list1, 'parity-sessions-list', '2026-11-01T10:00:00Z', false],
  [T.list2, 'parity-sessions-list', '2026-11-01T10:01:00Z', true],
  [T.other, 'parity-sessions-other', '2026-11-01T10:02:00Z', false],
  [T.endTs, 'parity-sessions-end-ts', '2026-11-01T10:00:00Z', false],
  [T.endTsOther, 'parity-sessions-end-ts', '2026-11-01T10:01:00Z', false],
  [T.endGo, 'parity-sessions-end-go', '2026-11-01T10:00:00Z', false],
  [T.endGoOther, 'parity-sessions-end-go', '2026-11-01T10:01:00Z', false],
  [T.selfTs, 'parity-sessions-self-ts', '2026-11-01T10:00:00Z', false],
  [T.selfGo, 'parity-sessions-self-go', '2026-11-01T10:00:00Z', false],
  [T.revokeTs, 'parity-sessions-revoke-ts', '2026-11-01T10:00:00Z', false],
  [T.revokeTsA, 'parity-sessions-revoke-ts', '2026-11-01T10:01:00Z', false],
  [T.revokeTsB, 'parity-sessions-revoke-ts', '2026-11-01T10:02:00Z', true],
  [T.revokeGo, 'parity-sessions-revoke-go', '2026-11-01T10:00:00Z', false],
  [T.revokeGoA, 'parity-sessions-revoke-go', '2026-11-01T10:01:00Z', false],
  [T.revokeGoB, 'parity-sessions-revoke-go', '2026-11-01T10:02:00Z', true],
  [T.readerTs, 'parity-sessions-reader-ts', '2026-11-01T10:00:00Z', false],
  [T.readerTsOther, 'parity-sessions-reader-ts', '2026-11-01T10:01:00Z', false],
  [T.readerGo, 'parity-sessions-reader-go', '2026-11-01T10:00:00Z', false],
  [T.readerGoOther, 'parity-sessions-reader-go', '2026-11-01T10:01:00Z', false],
];

export const seed = `
INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
${USERS.map(([user, role]) => `  ('${user}', 'Paridad Sesiones', 'x', '${role}', true, true)`).join(',\n')};
INSERT INTO grants (username, tenant_id) VALUES
${USERS.map(([user]) => `  ('${user}', '${SCOPE}')`).join(',\n')};
INSERT INTO sessions (token_hash, username, expires_at, created_at, via_google) VALUES
${SESSIONS.map(
  ([t, user, created, google]) =>
    `  ('${sha256(t)}', '${user}', '2099-01-01T00:00:00Z', '${created}', ${google})`,
).join(',\n')},
  ('${sha256(T.listExpired)}', 'parity-sessions-list', '2026-01-01T08:00:00Z', '2026-01-01T00:00:00Z', false);
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

const end = perApi(
  { cur: T.endTs, other: T.endTsOther, id: idOf(T.endTsOther) },
  { cur: T.endGo, other: T.endGoOther, id: idOf(T.endGoOther) },
);
const self = perApi({ cur: T.selfTs, id: idOf(T.selfTs) }, { cur: T.selfGo, id: idOf(T.selfGo) });
const revoke = perApi(
  { cur: T.revokeTs, other: T.revokeTsA },
  { cur: T.revokeGo, other: T.revokeGoA },
);
const reader = perApi(
  { cur: T.readerTs, other: T.readerTsOther, id: idOf(T.readerTsOther) },
  { cur: T.readerGo, other: T.readerGoOther, id: idOf(T.readerGoOther) },
);
const varied = { cookie: 'sipges_session={cur}' };
const variedOther = { cookie: 'sipges_session={other}' };

export const cases: readonly ParityCase[] = [
  // Listing: own sessions only, newest first, this one marked, the expired one left out.
  {
    name: 'sessions: list',
    method: 'GET',
    path: SESSIONS_PATH,
    headers: cookie(T.list1),
    present: [idOf(T.list1), idOf(T.list2), '"current":true', '"google"'],
    absent: [idOf(T.other), idOf(T.listExpired), ...secretFree],
  },
  {
    name: 'sessions: list from the Google session',
    method: 'GET',
    path: SESSIONS_PATH,
    headers: cookie(T.list2),
    absent: secretFree,
  },
  { name: 'sessions: list as consulta', method: 'GET', path: SESSIONS_PATH, auth: 'consulta' },
  { name: 'sessions: list without a session', method: 'GET', path: SESSIONS_PATH },
  {
    name: 'sessions: list with an unknown session',
    method: 'GET',
    path: SESSIONS_PATH,
    headers: cookie(token('ee')),
  },

  // Ending one: another user's id, unknown and malformed ids answer the same 404.
  ...[
    ['of another user', idOf(T.other)],
    ['of an unknown id', '0'.repeat(32)],
    ['of an upper-case id', 'A'.repeat(32)],
    ['by its token', T.list2],
    ['by its stored hash', sha256(T.list2)],
    ['of an expired session', idOf(T.listExpired)],
  ].map(([what, id]): ParityCase => ({
    name: `sessions: end ${what}`,
    method: 'DELETE',
    path: `${SESSIONS_PATH}/${id}`,
    headers: cookie(T.list1),
    sameOrigin: true,
  })),
  {
    name: "sessions: another user's session still works",
    method: 'GET',
    path: '/system/auth/me',
    headers: cookie(T.other),
    present: ['parity-sessions-other'],
  },
  {
    name: 'sessions: end without Origin',
    method: 'DELETE',
    path: `${SESSIONS_PATH}/${idOf(T.list2)}`,
    headers: cookie(T.list1),
  },
  {
    name: 'sessions: end from another site',
    method: 'DELETE',
    path: `${SESSIONS_PATH}/${idOf(T.list2)}`,
    headers: { ...cookie(T.list1), origin: 'https://evil.example' },
  },
  {
    name: 'sessions: end without a session',
    method: 'DELETE',
    path: `${SESSIONS_PATH}/${idOf(T.list2)}`,
    sameOrigin: true,
  },
  {
    name: 'sessions: the refused writes ended nothing',
    method: 'GET',
    path: SESSIONS_PATH,
    headers: cookie(T.list2),
    present: [idOf(T.list1), idOf(T.list2)],
  },
  {
    name: 'sessions: end another own session',
    method: 'DELETE',
    path: `${SESSIONS_PATH}/{id}`,
    headers: varied,
    sameOrigin: true,
    vary: end,
  },
  {
    name: 'sessions: the ended session is closed',
    method: 'GET',
    path: '/system/auth/me',
    headers: variedOther,
    vary: end,
    present: ['null'],
  },
  {
    name: 'sessions: the ending session stays open',
    method: 'GET',
    path: SESSIONS_PATH,
    headers: varied,
    vary: end,
    normalize: ['sessions.*.id'],
  },
  {
    name: 'sessions: end the current session',
    method: 'DELETE',
    path: `${SESSIONS_PATH}/{id}`,
    headers: varied,
    sameOrigin: true,
    vary: self,
  },
  {
    name: 'sessions: the current session is closed after ending it',
    method: 'GET',
    path: '/system/auth/me',
    headers: varied,
    vary: self,
    present: ['null'],
  },
  {
    name: 'sessions: a read-only account ends its own other session',
    method: 'DELETE',
    path: `${SESSIONS_PATH}/{id}`,
    headers: varied,
    sameOrigin: true,
    vary: reader,
  },

  // «Cerrar sesión en todos los demás»: keeps this one, ends the rest, counts them.
  {
    name: 'sessions: revoke others without a session',
    method: 'POST',
    path: REVOKE,
    sameOrigin: true,
  },
  {
    name: 'sessions: revoke others without Origin',
    method: 'POST',
    path: REVOKE,
    headers: cookie(T.list1),
  },
  {
    name: 'sessions: revoke others',
    method: 'POST',
    path: REVOKE,
    headers: varied,
    sameOrigin: true,
    vary: revoke,
    present: ['"count":2'],
  },
  {
    name: 'sessions: only this session is left',
    method: 'GET',
    path: SESSIONS_PATH,
    headers: varied,
    vary: revoke,
    normalize: ['sessions.*.id'],
  },
  {
    name: 'sessions: a revoked session is closed',
    method: 'GET',
    path: '/system/auth/me',
    headers: variedOther,
    vary: revoke,
    present: ['null'],
  },
  {
    name: 'sessions: revoke others again',
    method: 'POST',
    path: REVOKE,
    headers: varied,
    sameOrigin: true,
    vary: revoke,
    present: ['"count":0'],
  },
  {
    name: 'sessions: other users keep their sessions',
    method: 'GET',
    path: '/system/auth/me',
    headers: cookie(T.other),
    present: ['parity-sessions-other'],
  },
  {
    name: 'sessions: the audit trail records the writes without secrets',
    method: 'GET',
    path: '/system/audit?limit=100',
    auth: 'admin',
    normalize: ['*.ts'],
    present: ['"module":"Sesiones"', 'SESSION_END', 'SESSIONS_END_OTHERS'],
    absent: secretFree,
  },
];

import type { ParityCase } from '../types.ts';

/**
 * The tenancy administration routes (T33): the user's projects, the project choice, project
 * creation and grants. Both APIs share one database and receive each case at the same time, so
 * a write that is not idempotent runs per API (`perApi`): each creates or revokes its own
 * `…-TSAPI` / `…-GOAPI` target and the answers compare with that name read back as `{api}`.
 * Every write is followed by a read that proves what it stored, and the grants added to
 * `parity-multi` are revoked again at the end, so later contexts see the seeded state.
 *
 * The synthetic grantees below exist only in this run; `PARITY/OTRO` (fixtures.ts) is a
 * project of another company that nobody holds.
 */
export const seed = `
INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled) VALUES
  ('parity-grantee-TSAPI', 'Paridad sintética', 'x', 'analista', true, true),
  ('parity-grantee-GOAPI', 'Paridad sintética', 'x', 'analista', true, true);
`;

const SCOPES = '/system/auth/scopes';
const GRANTS = '/system/auth/grants';
const SELECT = '/select-project';
const CURRENT = '/system/auth/current-scope';
const OTHER = { company_id: 'PARITY', project_id: 'OTRO' };
const DEFAULT = { company_id: 'SIPGES', project_id: 'PRJ-SECHURA' };
const GRANTEE = 'parity-grantee-{api}';
const MULTI = 'parity-multi';

/** A case's options: `auth: 'none'` sends no session, `crossOrigin` no Origin header. */
type Extra = {
  readonly auth?: NonNullable<ParityCase['auth']> | 'none';
  readonly crossOrigin?: true;
  readonly headers?: Readonly<Record<string, string>>;
  readonly perApi?: true;
};

const build = (
  name: string,
  method: ParityCase['method'],
  path: string,
  body: ParityCase['body'] | undefined,
  { auth = 'admin', crossOrigin, headers, perApi }: Extra,
): ParityCase => ({
  name: `tenancy: ${name}`,
  method,
  path,
  ...(body ? { body } : {}),
  ...(auth === 'none' ? {} : { auth }),
  ...(method === 'GET' || method === 'HEAD' || crossOrigin ? {} : { sameOrigin: true as const }),
  ...(headers ? { headers } : {}),
  ...(perApi ? { perApi } : {}),
});

const write = (
  name: string,
  method: 'POST' | 'DELETE',
  path: string,
  body: NonNullable<ParityCase['body']>,
  extra: Extra = {},
) => build(name, method, path, body, extra);

const read = (name: string, path: string, extra: Extra = {}) =>
  build(name, 'GET', path, undefined, extra);

const json = (value: unknown) => ({ json: value });
const form = (value: Record<string, string>) => ({ form: value });

/** The 422s every JSON route answers before any rule. */
const malformed = (path: string, method: 'POST' | 'DELETE', fields: Record<string, string>) => [
  write(`${method} ${path} invalid JSON`, method, path, { raw: '{' }),
  write(`${method} ${path} empty body`, method, path, { raw: '' }),
  write(`${method} ${path} array`, method, path, { raw: '[]' }),
  write(`${method} ${path} -1e400`, method, path, { raw: '-1e400' }),
  write(`${method} ${path} nesting deeper than 10000`, method, path, {
    raw: `${'['.repeat(12_000)}${']'.repeat(12_000)}`,
  }),
  write(`${method} ${path} no fields`, method, path, json({})),
  write(
    `${method} ${path} wrong types`,
    method,
    path,
    json({ ...fields, username: 7, company_id: null }),
  ),
  write(`${method} ${path} NUL`, method, path, json({ ...fields, username: 'admin\u0000' })),
  write(`${method} ${path} NUL and a missing field`, method, path, json({ company_id: 'A\u0000' })),
  write(`${method} ${path} byte order mark`, method, path, {
    raw: `\uFEFF${JSON.stringify({ ...fields, username: 'nobody' })}`,
  }),
];

const multiIn = (scope: string): Extra => ({ auth: 'multi', headers: { 'x-sipges-scope': scope } });

export const cases: readonly ParityCase[] = [
  // GET /system/auth/scopes: only the caller's own grants, whatever the request names.
  read('scopes of the administrator', SCOPES),
  read('scopes of the read-only role', SCOPES, { auth: 'consulta' }),
  read('scopes of a user with two projects', SCOPES, { auth: 'multi' }),
  read('scopes without a session', SCOPES, { auth: 'none' }),
  read('scopes with an unknown session', SCOPES, {
    auth: 'none',
    headers: { cookie: `sipges_session=${'0'.repeat(64)}` },
  }),
  read('scopes with a trailing slash', `${SCOPES}/`),
  build('scopes HEAD', 'HEAD', SCOPES, undefined, {}),
  read("scopes never list another user's grants", `${SCOPES}?username=${MULTI}`),
  read('scopes ignore a project header (scope free)', SCOPES, {
    headers: { 'x-sipges-scope': 'PARITY/OTRO' },
  }),
  read('scopes ignore a project_id query (scope free)', `${SCOPES}?project_id=OTRO`),

  // GET /select-project: the page lists the granted projects, escaped; anonymous goes to login.
  read('select page anonymous', SELECT, { auth: 'none' }),
  read('select page with an unknown session', SELECT, {
    auth: 'none',
    headers: { cookie: `sipges_session=${'0'.repeat(64)}` },
  }),
  read('select page of the administrator', SELECT),
  read('select page of a user with two projects', SELECT, { auth: 'multi' }),

  // POST /select-project: Origin, session, form and grant checks.
  write('choice without Origin', 'POST', SELECT, form({ scope: 'SIPGES/PRJ-SECHURA' }), {
    crossOrigin: true,
  }),
  write('choice without a session', 'POST', SELECT, form({ scope: 'SIPGES/PRJ-SECHURA' }), {
    auth: 'none',
  }),
  write('choice of a granted project', 'POST', SELECT, form({ scope: 'SIPGES/PRJ-SECHURA' })),
  write('choice of the second project', 'POST', SELECT, form({ scope: 'PARITY/PRJ-B' }), {
    auth: 'multi',
  }),
  write('choice by the read-only role', 'POST', SELECT, form({ scope: 'SIPGES/PRJ-SECHURA' }), {
    auth: 'consulta',
  }),
  write("choice of another company's project", 'POST', SELECT, form({ scope: 'PARITY/OTRO' })),
  write('choice of a project of another user', 'POST', SELECT, form({ scope: 'PARITY/PRJ-B' })),
  write('choice without a scope', 'POST', SELECT, form({ other: '1' })),
  write('choice as JSON', 'POST', SELECT, json({ scope: 'SIPGES/PRJ-SECHURA' })),
  write(
    'choice with a repeated key',
    'POST',
    SELECT,
    {
      raw: 'scope=PARITY%2FOTRO&scope=SIPGES%2FPRJ-SECHURA',
    },
    { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
  ),

  // POST and DELETE /system/auth/grants, POST /system/auth/scopes: gates and validation.
  ...(
    [
      ['POST', GRANTS],
      ['DELETE', GRANTS],
      ['POST', SCOPES],
    ] as const
  ).flatMap(([m, path]) => {
    const body =
      path === SCOPES
        ? json({ ...OTHER, project_id: 'T33-NEVER', label: 'Nunca', username: MULTI })
        : json({ username: MULTI, ...OTHER });
    return [
      write(`${m} ${path} without a session`, m, path, body, { auth: 'none' }),
      write(`${m} ${path} without Origin`, m, path, body, { crossOrigin: true }),
      write(`${m} ${path} by the read-only role`, m, path, body, { auth: 'consulta' }),
      // multi (analista) passes the role gate; the route refuses non-administrators.
      write(`${m} ${path} by an analyst`, m, path, body, { auth: 'multi' }),
      write(
        `${m} ${path} by an analyst with an invalid body`,
        m,
        path,
        { raw: '[]' },
        { auth: 'multi' },
      ),
    ];
  }),
  ...malformed(GRANTS, 'POST', { username: MULTI, ...OTHER }),
  ...malformed(GRANTS, 'DELETE', { username: MULTI, ...OTHER }),
  ...malformed(SCOPES, 'POST', { ...OTHER, label: 'x', username: MULTI }),
  write('revoke with empty text', 'DELETE', GRANTS, json({ username: '', ...OTHER })),
  write(
    'revoke with 121 characters',
    'DELETE',
    GRANTS,
    json({ username: 'u'.repeat(121), ...OTHER }),
  ),
  write('grant to a missing user', 'POST', GRANTS, json({ username: 'parity-nobody', ...DEFAULT })),
  write(
    'grant into a missing project',
    'POST',
    GRANTS,
    json({ username: MULTI, company_id: 'NO', project_id: 'PE' }),
  ),
  write(
    'revoke of a missing user',
    'DELETE',
    GRANTS,
    json({ username: 'parity-nobody', ...DEFAULT }),
  ),
  write('revoke of an absent grant', 'DELETE', GRANTS, json({ username: MULTI, ...OTHER })),
  write(
    'create with a short id',
    'POST',
    SCOPES,
    json({ company_id: 'P', project_id: 'X1', label: 'x', username: MULTI }),
  ),
  write(
    'create with a space',
    'POST',
    SCOPES,
    json({ company_id: 'PARITY', project_id: 'has space', label: 'x', username: MULTI }),
  ),
  write(
    'create the reserved project',
    'POST',
    SCOPES,
    json({ ...DEFAULT, label: 'x', username: MULTI }),
  ),
  write(
    'create an existing project',
    'POST',
    SCOPES,
    json({ ...OTHER, label: 'Otra', username: MULTI }),
  ),
  write(
    'create for a missing user',
    'POST',
    SCOPES,
    json({ company_id: 'PARITY', project_id: 'T33-NONE', label: 'x', username: 'parity-nobody' }),
  ),

  // Cross-tenant: an analyst cannot grant itself another company's project, and the refused
  // write left no trace (the project still does not resolve for it).
  write(
    'an analyst grants itself another company',
    'POST',
    GRANTS,
    json({ username: MULTI, ...OTHER }),
    {
      auth: 'multi',
    },
  ),
  write(
    'a body project_id does not bypass the admin check',
    'POST',
    GRANTS,
    json({ username: MULTI, ...OTHER, project_id: 'OTRO' }),
    {
      auth: 'multi',
    },
  ),
  read('the refused cross-tenant grant left no access', CURRENT, multiIn('PARITY/OTRO')),

  // An administrator grants a project of another company, idempotently; the revoke proves the
  // grant was stored, and a second revoke that it is gone.
  write('grant into another company', 'POST', GRANTS, json({ username: GRANTEE, ...OTHER }), {
    perApi: true,
  }),
  write('grant repeated', 'POST', GRANTS, json({ username: GRANTEE, ...OTHER }), { perApi: true }),
  write('revoke of the stored grant', 'DELETE', GRANTS, json({ username: GRANTEE, ...OTHER }), {
    perApi: true,
  }),
  write('revoke repeated', 'DELETE', GRANTS, json({ username: GRANTEE, ...OTHER }), {
    perApi: true,
  }),

  // Creation stores the project and its first grant: a repeat is 409, the user lists it (label
  // cut to 120 code units), resolves it at once, and the choice page shows it escaped.
  write(
    'create a project',
    'POST',
    SCOPES,
    json({
      company_id: 'PARITY',
      project_id: 'T33-{api}',
      label: `<b>"Paridad" & 'T33' {api}</b>${'L'.repeat(110)}`,
      username: MULTI,
    }),
    { perApi: true },
  ),
  write(
    'create the same project again',
    'POST',
    SCOPES,
    json({
      company_id: 'PARITY',
      project_id: 'T33-{api}',
      label: 'Otra',
      username: MULTI,
    }),
    { perApi: true },
  ),
  read('the created project is listed', SCOPES, { auth: 'multi' }),
  read('the created project resolves at once', CURRENT, {
    ...multiIn('PARITY/T33-{api}'),
    perApi: true,
  }),
  read('the created project is offered', SELECT, { auth: 'multi' }),
  write(
    'a granted choice of the created project',
    'POST',
    SELECT,
    form({ scope: 'PARITY/T33-{api}' }),
    {
      auth: 'multi',
      perApi: true,
    },
  ),
  write(
    'grant the created project to another user',
    'POST',
    GRANTS,
    json({ username: GRANTEE, company_id: 'PARITY', project_id: 'T33-{api}' }),
    { perApi: true },
  ),
  write(
    'revoke that grant',
    'DELETE',
    GRANTS,
    json({ username: GRANTEE, company_id: 'PARITY', project_id: 'T33-{api}' }),
    { perApi: true },
  ),

  // Revoking the creation's grant takes effect at once; the session survives.
  write(
    'revoke the creation grant',
    'DELETE',
    GRANTS,
    json({ username: MULTI, company_id: 'PARITY', project_id: 'T33-{api}' }),
    { perApi: true },
  ),
  write(
    'revoke the creation grant again',
    'DELETE',
    GRANTS,
    json({ username: MULTI, company_id: 'PARITY', project_id: 'T33-{api}' }),
    { perApi: true },
  ),
  read('a revoked project no longer resolves', CURRENT, {
    ...multiIn('PARITY/T33-{api}'),
    perApi: true,
  }),
  read('the user keeps its seeded projects', SCOPES, { auth: 'multi' }),
  read('the session survives the revoke', '/system/auth/me', { auth: 'multi' }),
];

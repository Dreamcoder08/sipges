import { describe, expect, it } from 'vitest';
import type {
  GoogleAuthRequest,
  GoogleProfile,
  GoogleSignIn,
} from '../../src/contexts/identity/application/ports.ts';
import { totp } from '../../src/contexts/identity/infrastructure/totp.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { TEST_ENV, createTestApp } from '../support/test-app.ts';

// ADR 0010: "Entrar con Google" for accounts an administrator linked beforehand.

const ADMIN = { username: 'admin', password: 'admin-password-123' };
const COUSIN = {
  username: 'prima',
  full_name: 'Prima Sintética',
  password: 'cousin-pass-1234',
  role: 'consulta',
};
const COUSIN_EMAIL = 'prima.sintetica@example.com';
const MFA_ON = { MASCLI_REQUIRE_MFA: '1' };

/** Stands in for Google: records each exchange and answers with the profile the test sets. */
const fakeGoogle = () => {
  const exchanges: { code: string; request: GoogleAuthRequest }[] = [];
  let profile: GoogleProfile | null = { email: COUSIN_EMAIL, name: 'Prima' };
  const google: GoogleSignIn = {
    authorizationUrl: (request) =>
      `https://accounts.google.test/auth?${new URLSearchParams({
        state: request.state,
        redirect_uri: request.redirectUri,
      })}`,
    exchange: async (code, request) => {
      exchanges.push({ code, request });
      return profile;
    },
  };
  return {
    google,
    exchanges,
    answer: (next: GoogleProfile | null) => {
      profile = next;
    },
  };
};

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

const setup = async (env: Record<string, string> = {}) => {
  const fake = fakeGoogle();
  const t = await createTestApp(env, { googleSignIn: fake.google });
  return { t, ...fake };
};

/** Admin session; with MFA enforced it enrolls TOTP first, as a real administrator would. */
const adminCookie = async (t: TestApp) => {
  const { cookie } = await t.login(ADMIN.username, ADMIN.password);
  const setup = await t.request('/system/auth/totp/setup', { method: 'POST', headers: { cookie } });
  const { secret } = (await setup.json()) as { secret: string };
  await t.request('/system/auth/totp/enable', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ code: totp.codeAt(secret, t.clock.now()) }),
  });
  return cookie;
};

const link = (t: TestApp, cookie: string, username: string, email: string) =>
  t.request(`/system/auth/accounts/${username}/google`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });

/** Starts the flow and returns what the browser would carry back from Google. */
const start = async (t: TestApp) => {
  const res = await t.request('/auth/google');
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location') ?? '');
  const flowCookie = res.headers.getSetCookie().find((c) => c.startsWith('mascli_google_flow='));
  return {
    res,
    location,
    state: location.searchParams.get('state') ?? '',
    flowCookie: flowCookie ?? '',
    cookie: (flowCookie ?? '').split(';')[0] ?? '',
  };
};

const callback = (t: TestApp, query: Record<string, string>, cookie: string) =>
  t.request(`/auth/google/callback?${new URLSearchParams(query)}`, { headers: { cookie } });

const sessionCookie = (res: Response) => {
  const token = /mascli_session=([0-9a-f]{64})/.exec(res.headers.getSetCookie().join('\n'))?.[1];
  return token ? `mascli_session=${token}` : '';
};

describe('Google sign-in availability', () => {
  it('is hidden and unreachable without a configured client', async () => {
    const t = await createTestApp();
    expect(await (await t.request('/system/auth/providers')).json()).toEqual({ google: false });
    expect((await t.request('/auth/google')).status).toBe(404);
    expect((await t.request('/auth/google/callback?state=x&code=y')).status).toBe(404);
  });

  it('is advertised publicly when a client is configured', async () => {
    const { t } = await setup();
    expect(await (await t.request('/system/auth/providers')).json()).toEqual({ google: true });
  });

  it('requires both client values and a client for the bootstrap address', () => {
    const base = { MASCLI_DATA_KEY: TEST_ENV.MASCLI_DATA_KEY };
    expect(loadConfig(base).google).toBeUndefined();
    expect(
      loadConfig({
        ...base,
        MASCLI_GOOGLE_CLIENT_ID: 'client.apps.example',
        MASCLI_GOOGLE_CLIENT_SECRET: 'synthetic-secret',
      }).google,
    ).toEqual({
      clientId: 'client.apps.example',
      clientSecret: 'synthetic-secret',
      adminEmail: undefined,
    });
    expect(() => loadConfig({ ...base, MASCLI_GOOGLE_CLIENT_ID: 'client.apps.example' })).toThrow(
      'Set both MASCLI_GOOGLE_CLIENT_ID and MASCLI_GOOGLE_CLIENT_SECRET, or neither',
    );
    expect(() => loadConfig({ ...base, MASCLI_GOOGLE_ADMIN_EMAIL: COUSIN_EMAIL })).toThrow(
      'MASCLI_GOOGLE_ADMIN_EMAIL requires a Google OAuth client',
    );
  });
});

describe('Google sign-in flow', () => {
  it('signs a linked account in, and the session counts as its second factor', async () => {
    const { t, exchanges } = await setup(MFA_ON);
    const admin = await adminCookie(t);
    expect((await t.createAccount(admin, COUSIN)).status).toBe(200);
    expect((await link(t, admin, COUSIN.username, ' Prima.Sintetica@Example.com ')).status).toBe(
      200,
    );

    const flow = await start(t);
    expect(flow.location.origin).toBe('https://accounts.google.test');
    expect(flow.location.searchParams.get('redirect_uri')).toBe(
      'https://localhost/auth/google/callback',
    );
    expect(flow.flowCookie).toMatch(/HttpOnly/);
    expect(flow.flowCookie).toMatch(/SameSite=Lax/);
    expect(flow.flowCookie).toMatch(/Path=\/auth\/google/);

    const done = await callback(t, { state: flow.state, code: 'synthetic-code' }, flow.cookie);
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('/');
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.code).toBe('synthetic-code');
    expect(exchanges[0]?.request.state).toBe(flow.state);
    expect(exchanges[0]?.request.redirectUri).toBe('https://localhost/auth/google/callback');
    // The flow cookie is single-use: the callback clears it.
    expect(done.headers.getSetCookie().join('\n')).toMatch(/mascli_google_flow=;/);

    const cookie = sessionCookie(done);
    expect(cookie).not.toBe('');
    expect(done.headers.getSetCookie().join('\n')).toMatch(/SameSite=Strict/);
    expect(await (await t.request('/system/auth/me', { headers: { cookie } })).json()).toEqual({
      username: COUSIN.username,
      full_name: COUSIN.full_name,
      role: 'consulta',
      active: 1,
    });
    // A password session of the same user would still be sent to TOTP enrollment.
    expect((await t.request('/system/auth/scopes', { headers: { cookie } })).status).toBe(200);
    const password = await t.login(COUSIN.username, COUSIN.password);
    const blocked = await t.request('/system/auth/scopes', {
      headers: { cookie: password.cookie },
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ mfa_required: true });
  });

  it('refuses a missing, foreign or replayed state', async () => {
    const { t, exchanges } = await setup();
    const flow = await start(t);
    const other = await start(t);

    const noCookie = await callback(t, { state: flow.state, code: 'c' }, '');
    expect(noCookie.headers.get('location')).toBe('/login?google=expired');
    const mismatch = await callback(t, { state: other.state, code: 'c' }, flow.cookie);
    expect(mismatch.headers.get('location')).toBe('/login?google=expired');
    const noState = await callback(t, { code: 'c' }, flow.cookie);
    expect(noState.headers.get('location')).toBe('/login?google=expired');
    expect(exchanges).toHaveLength(0);
  });

  it('reports a cancelled consent and a failed exchange without a session', async () => {
    const { t, answer } = await setup();
    const cancelled = await start(t);
    const denied = await callback(
      t,
      { state: cancelled.state, error: 'access_denied' },
      cancelled.cookie,
    );
    expect(denied.headers.get('location')).toBe('/login?google=cancelled');
    expect(sessionCookie(denied)).toBe('');

    answer(null);
    const failed = await start(t);
    const res = await callback(t, { state: failed.state, code: 'c' }, failed.cookie);
    expect(res.headers.get('location')).toBe('/login?google=failed');
    expect(sessionCookie(res)).toBe('');
  });

  it('admits only linked, active accounts', async () => {
    const { t, answer } = await setup();
    const admin = await adminCookie(t);
    await t.createAccount(admin, COUSIN);

    const unknown = await start(t);
    const res = await callback(t, { state: unknown.state, code: 'c' }, unknown.cookie);
    expect(res.headers.get('location')).toBe('/login?google=not_linked');
    expect(sessionCookie(res)).toBe('');

    await link(t, admin, COUSIN.username, COUSIN_EMAIL);
    await t.request(`/system/auth/accounts/${COUSIN.username}/deactivate`, {
      method: 'POST',
      headers: { cookie: admin },
    });
    const inactive = await start(t);
    const refused = await callback(t, { state: inactive.state, code: 'c' }, inactive.cookie);
    expect(refused.headers.get('location')).toBe('/login?google=not_linked');

    answer({ email: 'otra.persona@example.com', name: 'Otra' });
    const stranger = await start(t);
    const other = await callback(t, { state: stranger.state, code: 'c' }, stranger.cookie);
    expect(other.headers.get('location')).toBe('/login?google=not_linked');
  });
});

describe('Google account links', () => {
  it('are managed by administrators only, with one account per address', async () => {
    const { t } = await setup();
    const admin = await adminCookie(t);
    await t.createAccount(admin, COUSIN);
    await t.createAccount(admin, { ...COUSIN, username: 'analista1', role: 'analista' });

    const linked = await link(t, admin, COUSIN.username, COUSIN_EMAIL);
    expect(await linked.json()).toEqual({
      ok: true,
      username: COUSIN.username,
      google_email: COUSIN_EMAIL,
    });
    const accounts = (await (
      await t.request('/system/auth/accounts', { headers: { cookie: admin } })
    ).json()) as { username: string; google_email: string | null }[];
    expect(accounts.find((a) => a.username === COUSIN.username)?.google_email).toBe(COUSIN_EMAIL);
    expect(accounts.find((a) => a.username === 'admin')?.google_email).toBeNull();

    expect((await link(t, admin, 'analista1', COUSIN_EMAIL.toUpperCase())).status).toBe(409);
    expect((await link(t, admin, 'analista1', 'no-es-correo')).status).toBe(422);
    expect((await link(t, admin, 'analista1', 'a\u0000b@example.com')).status).toBe(422);
    expect((await link(t, admin, 'nadie', 'nadie@example.com')).status).toBe(404);

    const analyst = (await t.login('analista1', COUSIN.password)).cookie;
    expect((await link(t, analyst, 'analista1', 'yo@example.com')).status).toBe(403);
  });

  it('end Google sessions when the address changes or is removed', async () => {
    const { t } = await setup();
    const admin = await adminCookie(t);
    await t.createAccount(admin, COUSIN);
    await link(t, admin, COUSIN.username, COUSIN_EMAIL);
    const flow = await start(t);
    const cookie = sessionCookie(await callback(t, { state: flow.state, code: 'c' }, flow.cookie));
    const password = (await t.login(COUSIN.username, COUSIN.password)).cookie;

    const unlinked = await link(t, admin, COUSIN.username, '');
    expect(await unlinked.json()).toMatchObject({ google_email: null });
    expect(await (await t.request('/system/auth/me', { headers: { cookie } })).json()).toBeNull();
    // Password sessions are unaffected.
    expect(
      await (await t.request('/system/auth/me', { headers: { cookie: password } })).json(),
    ).toMatchObject({ username: COUSIN.username });

    const again = await start(t);
    const refused = await callback(t, { state: again.state, code: 'c' }, again.cookie);
    expect(refused.headers.get('location')).toBe('/login?google=not_linked');
  });

  it('links the bootstrap administrator from MASCLI_GOOGLE_ADMIN_EMAIL without overriding', async () => {
    const env = {
      MASCLI_GOOGLE_CLIENT_ID: 'client.apps.example',
      MASCLI_GOOGLE_CLIENT_SECRET: 'synthetic-secret',
      MASCLI_GOOGLE_ADMIN_EMAIL: 'Admin.Sintetico@Example.com',
    };
    const { t, answer } = await setup({ ...env, ...MFA_ON });
    answer({ email: 'admin.sintetico@example.com', name: 'Admin' });
    const flow = await start(t);
    const cookie = sessionCookie(await callback(t, { state: flow.state, code: 'c' }, flow.cookie));
    expect(
      await (await t.request('/system/auth/me', { headers: { cookie } })).json(),
    ).toMatchObject({ username: 'admin', role: 'admin' });
    const accounts = (await (
      await t.request('/system/auth/accounts', { headers: { cookie } })
    ).json()) as { username: string; google_email: string | null }[];
    expect(accounts.find((a) => a.username === 'admin')?.google_email).toBe(
      'admin.sintetico@example.com',
    );
  });
});

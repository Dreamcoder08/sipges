import { describe, expect, it } from 'vitest';
import { checkRoleAccess } from '../../src/contexts/identity/domain/access-policy.ts';
import { validateNewAccount } from '../../src/contexts/identity/domain/user.ts';
import { createTestApp } from '../support/test-app.ts';

const wrongLogin = (
  t: Awaited<ReturnType<typeof createTestApp>>,
  username = 'admin',
  ip?: string,
) =>
  t.request('/login', {
    method: 'POST',
    ...(ip ? { headers: { 'x-test-ip': ip } } : {}),
    body: t.form({ username, password: 'wrong-wrong-wrong' }),
  });

describe('login throttle under concurrency (verifier finding B1)', () => {
  it('lets at most 5 concurrent wrong guesses per user through', async () => {
    const t = await createTestApp();
    const responses = await Promise.all(Array.from({ length: 30 }, () => wrongLogin(t)));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(25);
  });

  it('lets at most 20 concurrent wrong guesses per address through', async () => {
    const t = await createTestApp();
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) => wrongLogin(t, `user${i}`)),
    );
    expect(responses.filter((r) => r.status === 401)).toHaveLength(20);
  });

  it('does not count a successful login as a failure', async () => {
    const t = await createTestApp();
    for (let i = 0; i < 10; i++) {
      expect((await t.login('admin', 'admin-password-123')).res.status).toBe(200);
    }
    const [row] = await t.sql.query<{ n: string | number }>(
      'SELECT count(*) AS n FROM login_failures',
    );
    expect(Number(row?.n)).toBe(0);
  });

  it('purges failure rows that left the window', async () => {
    const t = await createTestApp();
    for (let i = 0; i < 3; i++) await wrongLogin(t, `old${i}`);
    t.clock.advance(901);
    await wrongLogin(t, 'fresh');
    const rows = await t.sql.query<{ subject: string }>(
      'SELECT subject FROM login_failures ORDER BY subject',
    );
    expect(rows.map((r) => r.subject)).toEqual(['ip:203.0.113.1', 'user:fresh']);
  });
});

describe('role gate parity with app.py:244 (verifier finding A1)', () => {
  it.each(['HEAD', 'OPTIONS', 'POST', 'PUT'])('%s /system/irsa/config is admin-only', (method) => {
    expect(checkRoleAccess('analista', method, '/system/irsa/config')).toEqual({
      allowed: false,
      detail: 'Requiere rol administrador',
    });
    expect(checkRoleAccess('admin', method, '/system/irsa/config').allowed).toBe(true);
  });

  it('GET /system/irsa/config stays readable', () => {
    expect(checkRoleAccess('consulta', 'GET', '/system/irsa/config').allowed).toBe(true);
  });
});

describe('MFA with an unreadable sealed secret', () => {
  it('answers 401 instead of 500 and does not open a session', async () => {
    const t = await createTestApp();
    await t.sql.query(
      "UPDATE users SET totp_enabled = true, totp_secret_sealed = 'v1.corrupted' WHERE username = 'admin'",
    );
    const { res } = await t.login('admin', 'admin-password-123', '123456');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: 'Código de autenticación inválido' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('password length counts code points like Python len()', () => {
  it('rejects 6 astral characters (12 UTF-16 units) as too short', () => {
    expect(
      validateNewAccount({
        username: 'emoji',
        fullName: 'E',
        password: '😀'.repeat(6),
        role: 'consulta',
      }),
    ).toEqual({ ok: false, error: 'Contraseña demasiado corta: mínimo 12 caracteres' });
    expect(
      validateNewAccount({
        username: 'emoji',
        fullName: 'E',
        password: '😀'.repeat(12),
        role: 'consulta',
      }).ok,
    ).toBe(true);
  });
});

describe('rejected account commands leave identity state unchanged', () => {
  it('keeps users and sessions byte-identical', async () => {
    const t = await createTestApp();
    const admin = await t.login('admin', 'admin-password-123');
    const dump = async () =>
      JSON.stringify([
        await t.sql.query('SELECT * FROM users ORDER BY username'),
        await t.sql.query('SELECT * FROM sessions ORDER BY token_hash'),
      ]);
    const before = await dump();
    for (const body of [
      { username: 'AB', full_name: 'x', password: 'long-enough-pass1', role: 'consulta' },
      { username: 'admin', full_name: 'x', password: 'long-enough-pass1', role: 'consulta' },
      { username: 'okname', full_name: 'x', password: 'short', role: 'consulta' },
    ]) {
      expect((await t.createAccount(admin.cookie, body)).status).toBeGreaterThanOrEqual(409);
    }
    expect(await dump()).toBe(before);
  });
});

describe('HSTS (ADR 0004)', () => {
  it('is sent when cookies are Secure', async () => {
    const t = await createTestApp();
    expect((await t.request('/health')).headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  it('is omitted for intentional local HTTP (MASCLI_COOKIE_SECURE=0)', async () => {
    const t = await createTestApp({ MASCLI_COOKIE_SECURE: '0' });
    expect((await t.request('/health')).headers.get('strict-transport-security')).toBeNull();
  });
});

describe('usernames that can never exist (re-verification advisories)', () => {
  it.each([
    ['a NUL byte', 'a\u0000b'],
    ['more than 120 characters', 'x'.repeat(121)],
  ])(
    'answers the uniform 401, not 500, for %s and still counts the attempt',
    async (_case, username) => {
      const t = await createTestApp();
      const res = await wrongLogin(t, username);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ detail: 'Credenciales inválidas' });
      const [row] = await t.sql.query<{ n: string | number }>(
        "SELECT count(*) AS n FROM login_failures WHERE subject = 'ip:203.0.113.1'",
      );
      expect(Number(row?.n)).toBe(1);
    },
  );
});

describe('wrong second factor under concurrency', () => {
  it('counts each wrong OTP against the throttle when the password is right', async () => {
    const t = await createTestApp();
    await t.sql.query("UPDATE users SET totp_enabled = true WHERE username = 'admin'");
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        t.request('/login', {
          method: 'POST',
          body: t.form({ username: 'admin', password: 'admin-password-123', otp: '000000' }),
        }),
      ),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(15);
  });
});

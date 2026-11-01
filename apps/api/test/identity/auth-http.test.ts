import { describe, expect, it } from 'vitest';
import type { PasswordHasher } from '../../src/contexts/identity/application/ports.ts';
import { totp } from '../../src/contexts/identity/infrastructure/totp.ts';
import { portablePasswordHasher } from '../../src/contexts/identity/infrastructure/portable-password-hasher.ts';
import { ORIGIN, createTestApp } from '../support/test-app.ts';

const ADMIN = { username: 'admin', password: 'admin-password-123' };
const ANALYST = {
  username: 'ana.perez',
  full_name: 'Ana Pérez',
  password: 'analyst-pass-123',
  role: 'analista',
};

const json = (res: Response) => res.json() as Promise<unknown>;

describe('POST /login', () => {
  it('opens a session with the bootstrap admin and sets the hardened cookie', async () => {
    const t = await createTestApp();
    const { res, token } = await t.login(ADMIN.username, ADMIN.password);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, name: 'Administrator', role: 'admin' });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Max-Age=28800');
    expect(cookie).toContain('Path=/');
  });

  it('omits Secure only when SIPGES_COOKIE_SECURE=0', async () => {
    const t = await createTestApp({ SIPGES_COOKIE_SECURE: '0' });
    const { res } = await t.login(ADMIN.username, ADMIN.password);
    expect(res.headers.get('set-cookie')).not.toContain('Secure');
  });

  it('normalizes the username like Python (trim + lower case)', async () => {
    const t = await createTestApp();
    expect((await t.login('  ADMIN ', ADMIN.password)).res.status).toBe(200);
  });

  it.each([
    ['wrong password', 'admin', 'wrong-password-000'],
    ['unknown user', 'nobody', 'admin-password-123'],
  ])('rejects %s with the uniform 401', async (_case, username, password) => {
    const t = await createTestApp();
    const { res } = await t.login(username, password);
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ detail: 'Credenciales inválidas' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects inactive accounts with the uniform 401', async () => {
    const t = await createTestApp();
    await t.sql.query("UPDATE users SET active = false WHERE username = 'admin'");
    const { res } = await t.login(ADMIN.username, ADMIN.password);
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ detail: 'Credenciales inválidas' });
  });

  it('answers missing form fields with a FastAPI-style 422', async () => {
    const t = await createTestApp();
    const res = await t.request('/login', { method: 'POST', body: t.form({ username: 'admin' }) });
    expect(res.status).toBe(422);
    expect(await json(res)).toEqual({
      detail: [{ type: 'missing', loc: ['body', 'password'], msg: 'Field required' }],
    });
  });

  it('upgrades a legacy PBKDF2 hash to Argon2id after a successful login', async () => {
    const t = await createTestApp();
    await t.sql.query(
      "INSERT INTO users (username, full_name, password_hash, role) VALUES ('legacy', 'Legacy', $1, 'analista')",
      [
        'pbkdf2_sha256$310000$00112233445566778899aabbccddeeff$0a7b250afe90c4ed092f7d9d891af455aea515fa4188554efab1469e53b108f6',
      ],
    );
    expect((await t.login('legacy', 'legacy-password-123')).res.status).toBe(200);
    const [row] = await t.sql.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE username = 'legacy'",
    );
    expect(row?.password_hash).toMatch(/^\$argon2id\$/);
    expect((await t.login('legacy', 'legacy-password-123')).res.status).toBe(200);
  });
});

describe('login throttling (ADR 0004)', () => {
  it('blocks a username after 5 failures, even with the right password, until the window passes', async () => {
    const t = await createTestApp();
    for (let i = 0; i < 5; i++) {
      expect((await t.login('admin', `wrong-password-${i}`)).res.status).toBe(401);
    }
    const blocked = await t.login(ADMIN.username, ADMIN.password);
    expect(blocked.res.status).toBe(429);
    expect(blocked.res.headers.get('retry-after')).toBe('900');
    expect(await json(blocked.res)).toEqual({
      detail: 'Demasiados intentos fallidos; intente más tarde',
    });
    expect(blocked.res.headers.get('set-cookie')).toBeNull();

    t.clock.advance(901);
    expect((await t.login(ADMIN.username, ADMIN.password)).res.status).toBe(200);
  });

  it('blocks an address after 20 failures across usernames', async () => {
    const t = await createTestApp();
    for (let i = 0; i < 20; i++) {
      await t.login(`user${i}`, 'whatever-password');
    }
    expect((await t.login(ADMIN.username, ADMIN.password)).res.status).toBe(429);
    const other = await t.request('/login', {
      method: 'POST',
      headers: { 'x-test-ip': '198.51.100.7' },
      body: t.form({ username: 'admin', password: ADMIN.password }),
    });
    expect(other.status).toBe(200);
  });

  it('clears the username counter after a successful login', async () => {
    const t = await createTestApp();
    for (let i = 0; i < 4; i++) await t.login('admin', 'wrong-password-x');
    expect((await t.login(ADMIN.username, ADMIN.password)).res.status).toBe(200);
    for (let i = 0; i < 4; i++) await t.login('admin', 'wrong-password-y');
    expect((await t.login(ADMIN.username, ADMIN.password)).res.status).toBe(200);
  });
});

describe('sessions', () => {
  it('GET /system/auth/me returns null anonymously and the identity with a session', async () => {
    const t = await createTestApp();
    const anon = await t.request('/system/auth/me');
    expect(anon.status).toBe(200);
    expect(await json(anon)).toBeNull();
    const { cookie } = await t.login(ADMIN.username, ADMIN.password);
    const me = await t.request('/system/auth/me', { headers: { cookie } });
    expect(await json(me)).toEqual({
      username: 'admin',
      full_name: 'Administrator',
      role: 'admin',
      active: 1,
    });
  });

  it('rejects protected routes without a session', async () => {
    const t = await createTestApp();
    const res = await t.request('/system/auth/accounts');
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ detail: 'Inicie sesión para acceder a SIPGES' });
  });

  it('expires sessions after exactly 8 hours', async () => {
    const t = await createTestApp();
    const { cookie } = await t.login(ADMIN.username, ADMIN.password);
    t.clock.advance(8 * 3600 - 1);
    expect((await t.request('/system/auth/accounts', { headers: { cookie } })).status).toBe(200);
    t.clock.advance(1);
    expect((await t.request('/system/auth/accounts', { headers: { cookie } })).status).toBe(401);
  });

  it('POST /logout deletes the session and clears both cookies', async () => {
    const t = await createTestApp();
    const { cookie } = await t.login(ADMIN.username, ADMIN.password);
    const res = await t.request('/logout', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    const cleared = res.headers.getSetCookie();
    expect(cleared.some((c) => c.startsWith('sipges_session=;') && c.includes('Max-Age=0'))).toBe(
      true,
    );
    expect(cleared.some((c) => c.startsWith('sipges_scope=;') && c.includes('Max-Age=0'))).toBe(
      true,
    );
    expect((await t.request('/system/auth/accounts', { headers: { cookie } })).status).toBe(401);
  });
});

describe('origin check (ADR 0004, ADR 0008 #4)', () => {
  it.each(['/login', '/logout', '/system/auth/accounts'])(
    'rejects cross-origin POST %s',
    async (path) => {
      const t = await createTestApp();
      const { cookie } = await t.login(ADMIN.username, ADMIN.password);
      const res = await t.request(path, {
        method: 'POST',
        headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify(ANALYST),
      });
      expect(res.status).toBe(403);
      expect(await json(res)).toEqual({ detail: 'Origen de solicitud no permitido' });
    },
  );

  it('accepts same-origin POST', async () => {
    const t = await createTestApp();
    const { cookie } = await t.login(ADMIN.username, ADMIN.password);
    const res = await t.request('/system/auth/accounts', {
      method: 'POST',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(ANALYST),
    });
    expect(res.status).toBe(200);
  });
});

describe('/system/auth/accounts', () => {
  it('lets an admin create and list accounts without exposing secrets', async () => {
    const t = await createTestApp();
    const { cookie } = await t.login(ADMIN.username, ADMIN.password);
    const created = await t.createAccount(cookie, ANALYST);
    expect(created.status).toBe(200);
    expect(await json(created)).toEqual({ ok: true, username: 'ana.perez', role: 'analista' });

    const list = (await json(
      await t.request('/system/auth/accounts', { headers: { cookie } }),
    )) as Record<string, unknown>[];
    expect(list.map((a) => a.username).sort()).toEqual(['admin', 'ana.perez']);
    for (const account of list) {
      expect(Object.keys(account).sort()).toEqual([
        'active',
        'created_at',
        'full_name',
        'google_email',
        'role',
        'username',
      ]);
      expect(account.active).toBe(1);
      expect(account.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
    expect((await t.login(ANALYST.username, ANALYST.password)).res.status).toBe(200);
  });

  it('defaults the role to consulta like Python', async () => {
    const t = await createTestApp();
    const { cookie } = await t.login(ADMIN.username, ADMIN.password);
    const res = await t.request('/system/auth/accounts', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'reader',
        full_name: 'Reader',
        password: 'reader-pass-1234',
      }),
    });
    expect(await json(res)).toEqual({ ok: true, username: 'reader', role: 'consulta' });
  });

  it.each([
    [{ ...ANALYST, username: 'A' }, 'Usuario inválido'],
    [{ ...ANALYST, role: 'root' }, 'Rol no válido'],
    [{ ...ANALYST, password: 'short' }, 'Contraseña demasiado corta: mínimo 12 caracteres'],
  ])('rejects invalid input with 422 and stores nothing', async (body, detail) => {
    const t = await createTestApp();
    const { cookie } = await t.login(ADMIN.username, ADMIN.password);
    const res = await t.createAccount(cookie, body);
    expect(res.status).toBe(422);
    expect(await json(res)).toEqual({ detail });
    const list = (await json(
      await t.request('/system/auth/accounts', { headers: { cookie } }),
    )) as unknown[];
    expect(list).toHaveLength(1);
  });

  it('rejects duplicates with 409 and keeps the original password', async () => {
    const t = await createTestApp();
    const { cookie } = await t.login(ADMIN.username, ADMIN.password);
    await t.createAccount(cookie, ANALYST);
    const dup = await t.createAccount(cookie, { ...ANALYST, password: 'another-pass-999' });
    expect(dup.status).toBe(409);
    expect(await json(dup)).toEqual({ detail: 'Usuario existente' });
    expect((await t.login(ANALYST.username, ANALYST.password)).res.status).toBe(200);
  });

  it('is restricted to admins', async () => {
    const t = await createTestApp();
    const admin = await t.login(ADMIN.username, ADMIN.password);
    await t.createAccount(admin.cookie, ANALYST);
    await t.grant(admin.cookie, ANALYST.username);
    const analyst = await t.login(ANALYST.username, ANALYST.password);
    for (const method of ['GET', 'POST']) {
      const res = await t.request('/system/auth/accounts', {
        method,
        headers: { cookie: analyst.cookie },
      });
      expect(res.status).toBe(403);
      expect(await json(res)).toEqual({ detail: 'Administración de cuentas restringida' });
    }
  });
});

describe('TOTP enrollment and login', () => {
  const setup = async () => {
    const t = await createTestApp();
    const admin = await t.login(ADMIN.username, ADMIN.password);
    await t.createAccount(admin.cookie, ANALYST);
    await t.grant(admin.cookie, ANALYST.username);
    const analyst = await t.login(ANALYST.username, ANALYST.password);
    return { t, analyst };
  };

  it('enrolls, encrypts the secret at rest, enables MFA and keeps only the current session', async () => {
    const { t, analyst } = await setup();
    const other = await t.login(ANALYST.username, ANALYST.password);

    const res = await t.request('/system/auth/totp/setup', {
      method: 'POST',
      headers: { cookie: analyst.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await json(res)) as { secret: string; otpauth_uri: string; instruction: string };
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.otpauth_uri).toBe(totp.uri('ana.perez', body.secret));
    expect(body.instruction).toBe(
      'Añada el código en una aplicación TOTP y confirme con /system/auth/totp/enable.',
    );

    const [stored] = await t.sql.query<{ totp_secret_sealed: string }>(
      "SELECT totp_secret_sealed FROM users WHERE username = 'ana.perez'",
    );
    expect(stored?.totp_secret_sealed).toMatch(/^v1\./);
    expect(stored?.totp_secret_sealed).not.toContain(body.secret);

    const enable = (code: string) =>
      t.request('/system/auth/totp/enable', {
        method: 'POST',
        headers: { cookie: analyst.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
    const bad = await enable(
      '000000' === totp.codeAt(body.secret, t.clock.now()) ? '111111' : '000000',
    );
    expect(bad.status).toBe(422);
    expect(await json(bad)).toEqual({ detail: 'Código TOTP incorrecto' });

    const good = await enable(totp.codeAt(body.secret, t.clock.now()));
    expect(good.status).toBe(200);
    expect(await json(good)).toEqual({ ok: true, totp_enabled: true });

    expect(
      (await t.request('/system/auth/me', { headers: { cookie: analyst.cookie } })).status,
    ).toBe(200);
    expect(
      await json(await t.request('/system/auth/me', { headers: { cookie: other.cookie } })),
    ).toBeNull();

    const again = await t.request('/system/auth/totp/setup', {
      method: 'POST',
      headers: { cookie: analyst.cookie },
    });
    expect(again.status).toBe(409);
    expect(await json(again)).toEqual({
      detail: 'MFA ya está activado; no se permite reiniciar la configuración',
    });

    const noCode = await t.login(ANALYST.username, ANALYST.password);
    expect(noCode.res.status).toBe(401);
    expect(await json(noCode.res)).toEqual({ detail: 'Código de autenticación inválido' });

    t.clock.advance(30);
    const code = totp.codeAt(body.secret, t.clock.now());
    expect((await t.login(ANALYST.username, ANALYST.password, code)).res.status).toBe(200);
    const replay = await t.login(ANALYST.username, ANALYST.password, code);
    expect(replay.res.status).toBe(401);
    expect(await json(replay.res)).toEqual({ detail: 'Código de autenticación inválido' });
  });

  it('lets the read-only role enroll MFA (self-service, ADR 0009)', async () => {
    const t = await createTestApp();
    const admin = await t.login(ADMIN.username, ADMIN.password);
    await t.createAccount(admin.cookie, { ...ANALYST, username: 'lector', role: 'consulta' });
    await t.grant(admin.cookie, 'lector');
    const reader = await t.login('lector', ANALYST.password);
    const res = await t.request('/system/auth/totp/setup', {
      method: 'POST',
      headers: { cookie: reader.cookie },
    });
    expect(res.status).toBe(200);
  });
});

describe('bootstrap admin', () => {
  it('refuses to start an empty installation without a strong admin password', async () => {
    await expect(createTestApp({ SIPGES_ADMIN_PASSWORD: 'short' })).rejects.toThrow(
      'Configure SIPGES_ADMIN_PASSWORD (mínimo 12 caracteres)',
    );
  });

  it('uses SIPGES_ADMIN_FULL_NAME instead of a hard-coded personal name (ADR 0008 #13)', async () => {
    const t = await createTestApp({ SIPGES_ADMIN_FULL_NAME: 'Mesa de Control' });
    const { res } = await t.login(ADMIN.username, ADMIN.password);
    expect(await json(res)).toEqual({ ok: true, name: 'Mesa de Control', role: 'admin' });
  });
});

describe('POST /login with the portable hasher (Cloudflare Workers)', () => {
  it('signs in through the injected hasher and refuses a wrong password', async () => {
    const used: string[] = [];
    const recording: PasswordHasher = {
      hash: (password) => portablePasswordHasher.hash(password),
      async verify(password, stored) {
        used.push('verify');
        return portablePasswordHasher.verify(password, stored);
      },
      needsRehash: (stored) => portablePasswordHasher.needsRehash(stored),
    };
    const t = await createTestApp({}, { passwordHasher: recording });
    expect((await t.login(ADMIN.username, ADMIN.password)).res.status).toBe(200);
    expect((await t.login(ADMIN.username, 'not-the-password')).res.status).toBe(401);
    expect(used).toEqual(['verify', 'verify']);
  });
});

import type { PGliteInterface } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

let previous: PGliteInterface;

describe('test application database lifecycle', { concurrent: false }, () => {
  it('provides a working isolated database for the current test', async () => {
    const t = await createTestApp();
    previous = t.db;
    expect(previous.closed).toBe(false);
    const admin = await t.login('admin', 'admin-password-123');
    expect(admin.res.status).toBe(200);
    const created = await t.createAccount(admin.cookie, {
      username: 'lifecycle.user',
      full_name: 'Lifecycle User',
      password: 'lifecycle-password-123',
      role: 'consulta',
    });
    expect(created.status).toBe(200);
  });

  it('closes the previous database and retains isolated bootstrap in the next test', async () => {
    expect(previous.closed).toBe(true);
    const t = await createTestApp();
    const admin = await t.login('admin', 'admin-password-123');
    expect(admin.res.status).toBe(200);
    const missing = await t.login('lifecycle.user', 'lifecycle-password-123');
    expect(missing.res.status).toBe(401);
    expect(t.db.closed).toBe(false);
  });
});

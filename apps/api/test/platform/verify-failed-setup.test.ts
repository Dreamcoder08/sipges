import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

let previous: PGliteInterface | undefined;
const captureRejectedClone = async (env: Record<string, string>, error: string) => {
  const original = PGlite.prototype.clone;
  const clones: PGliteInterface[] = [];
  const spy = vi.spyOn(PGlite.prototype, 'clone').mockImplementation(async function (this: PGlite) {
    const db = await original.call(this);
    clones.push(db);
    return db;
  });
  try {
    await expect(createTestApp(env)).rejects.toThrow(error);
    expect(clones).toHaveLength(1);
    expect(clones[0]!.closed).toBe(false);
    previous = clones[0];
  } finally {
    spy.mockRestore();
  }
};

describe('S3 T5d rejected setup ownership', { concurrent: false }, () => {
  it('owns allocation before synchronous configuration failure', async () => {
    await captureRejectedClone(
      { MASCLI_PORT: '0' },
      'MASCLI_PORT must be an integer between 1 and 65535',
    );
  });
  it('closes rejected configuration allocation and owns failed bootstrap', async () => {
    expect(previous?.closed).toBe(true);
    await captureRejectedClone({ MASCLI_ADMIN_PASSWORD: 'short' }, 'MASCLI_ADMIN_PASSWORD');
  });
  it('closes failed bootstrap allocation and permits a fresh working clone', async () => {
    expect(previous?.closed).toBe(true);
    const t = await createTestApp();
    expect((await t.login('admin', 'admin-password-123')).res.status).toBe(200);
  });
});

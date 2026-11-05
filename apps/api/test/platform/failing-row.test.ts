import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

// PostgreSQL's detail on a CHECK or NOT NULL violation holds the whole row, and users rows hold
// the password hash and the sealed TOTP secret. Node prints it for an unhandled rejection.
describe('a violated constraint on the users table', () => {
  it('keeps the error and drops the row from it', async () => {
    const error: unknown = await createTestApp({
      SIPGES_ADMIN_USERNAME: ' ',
      SIPGES_ADMIN_PASSWORD: 'synthetic-password-01',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe('23514');
    expect((error as Error).message).toContain('users_username_check');
    const printed = inspect(error);
    expect(printed).not.toContain('$argon2id$');
    expect(printed).not.toContain('Failing row contains (');
  });
});

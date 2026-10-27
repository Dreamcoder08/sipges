import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/** Workers have no file system, so migrations ship in src/migrations.ts; it must stay complete. */
describe('bundled migration index', () => {
  it('lists every API migration, in order', async () => {
    const dir = new URL('../../api/src/platform/database/migrations/', import.meta.url);
    const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
    const index = await readFile(new URL('../src/migrations.ts', import.meta.url), 'utf8');
    const versions = [...index.matchAll(/version: '([^']+)'/g)].map((m) => m[1]);
    expect(files.length).toBeGreaterThan(0);
    // Out of date? Run `pnpm --filter @mascli/hosting-cloudflare migrations`.
    expect(versions).toEqual(files.map((f) => f.replace(/\.sql$/, '')));
  });
});

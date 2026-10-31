import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * Hyperdrive caches reads outside transactions, which covers accounts, sessions and grants; a
 * cached read could keep a revoked session alive. Every deploy must re-assert caching off.
 */
describe('Workers deploy script', () => {
  it('turns Hyperdrive query caching off for the bound config before deploying', async () => {
    const config = await read('../wrangler.jsonc');
    const id = /"hyperdrive":\s*\[\{[^}]*"id":\s*"([0-9a-f]{32})"/.exec(config)?.[1];
    expect(id).toBeDefined();
    const { scripts } = JSON.parse(await read('../package.json')) as {
      scripts: Record<string, string>;
    };
    expect(scripts['deploy:worker']).toBe(
      `wrangler hyperdrive update ${id} --caching-disabled true && wrangler deploy`,
    );
  });
});

// Builds the SPA into ./public for Workers Static Assets and refreshes the migration index.
import { cp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const root = new URL('../../', import.meta.url);
// pnpm directly: Node 26 no longer ships corepack, and the repository pins pnpm.
execFileSync('pnpm', ['--filter', '@sipges/web', 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CI: '1' },
});
const output = new URL('./public/', import.meta.url);
await rm(output, { recursive: true, force: true });
await cp(new URL('./apps/web/dist/', root), output, { recursive: true });
await import('./generate-migrations.mjs');

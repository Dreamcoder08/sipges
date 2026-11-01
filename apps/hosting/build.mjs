import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const root = new URL('../../', import.meta.url);
execFileSync('corepack', ['pnpm', '--filter', '@sipges/web', 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CI: '1' },
});
const output = new URL('./public/', import.meta.url);
await rm(output, { recursive: true, force: true });
await cp(new URL('./apps/web/dist/', root), output, { recursive: true });
// Vercel transpiles traced .ts modules to .js, but leaves workspace package exports intact.
// Prepare JS package entrypoints only inside its disposable build checkout.
if (process.env.VERCEL === '1') {
  for (const name of ['kernel', 'contracts']) {
    execFileSync(
      'corepack',
      [
        'pnpm',
        '--filter',
        `@sipges/${name}`,
        'exec',
        'tsc',
        '-p',
        'tsconfig.json',
        '--noEmit',
        'false',
        '--outDir',
        'dist',
        '--rootDir',
        'src',
        '--rewriteRelativeImportExtensions',
        'true',
        '--declaration',
        'true',
      ],
      { cwd: root, stdio: 'inherit' },
    );
    const manifestPath = new URL(`packages/${name}/package.json`, root);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.exports = { '.': { types: './dist/index.d.ts', default: './dist/index.js' } };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
}

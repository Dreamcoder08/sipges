import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const root = new URL('../../', import.meta.url);
execFileSync('corepack', ['pnpm', '--filter', '@mascli/web', 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CI: '1' },
});
const output = new URL('./public/', import.meta.url);
await rm(output, { recursive: true, force: true });
await cp(new URL('./apps/web/dist/', root), output, { recursive: true });
const index = new URL('index.html', output);
const html = await readFile(index, 'utf8');
await writeFile(
  index,
  html
    .replace('</head>', '<link rel="stylesheet" href="/assets/demo-banner.css"></head>')
    .replace(
      '<body>',
      '<body><aside class="demo-banner">Demo académica · Solo datos sintéticos. Máximo 4 MiB por envío, incluyendo todos los archivos.</aside>',
    ),
);
await writeFile(
  new URL('assets/demo-banner.css', output),
  '.demo-banner{background:#123450;color:#fff;text-align:center;padding:.65rem;font:14px system-ui,sans-serif}',
);

// Vercel transpiles traced .ts modules to .js, but leaves workspace package exports intact.
// Prepare JS package entrypoints only inside its disposable build checkout.
if (process.env.VERCEL === '1') {
  for (const name of ['kernel', 'contracts']) {
    execFileSync(
      'corepack',
      [
        'pnpm',
        '--filter',
        `@mascli/${name}`,
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

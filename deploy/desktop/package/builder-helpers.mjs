// Test helpers: a throwaway checkout where deploy/desktop/package/builder.mjs runs end to end with
// a fake `pnpm` first on PATH (synthetic API and web build, no network, no real dependencies), so
// a complete build and a build that fails half-way can be produced in a temporary folder. Runs on
// Linux and Windows: builder.mjs starts pnpm through cmd.exe there, which finds `pnpm.cmd`.
import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const UPDATER = ['boot.mjs', 'launcher.mjs', 'release.mjs', 'update.mjs', 'updater.mjs'];

// CommonJS on purpose: the bin folder has no package.json.
const FAKE_PNPM = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
if (args.includes('deploy')) {
  const api = args[args.length - 1];
  mkdirSync(join(api, 'src'), { recursive: true });
  writeFileSync(join(api, 'package.json'), JSON.stringify({ type: 'module', scripts: { start: 'node src/main.ts' } }));
  writeFileSync(join(api, 'src/main.ts'), 'export const port: number = 0;\\n');
  for (const name of ['kernel', 'contracts']) {
    const root = join(api, 'node_modules', '@sipges', name);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@sipges/' + name, type: 'module', exports: { '.': './src/index.ts' } }));
    writeFileSync(join(root, 'src/index.ts'), 'export const value: string = "' + name + '";\\n');
  }
  process.exit(0);
}
if (args.includes('build')) {
  if (process.env.SIPGES_FAKE_WEB_BUILD === 'fail') {
    console.error('fake web build failed');
    process.exit(1);
  }
  mkdirSync('apps/web/dist', { recursive: true });
  writeFileSync('apps/web/dist/index.html', '<!doctype html>\\n<html>\\n  <head>\\n  </head>\\n  <body></body>\\n</html>\\n');
  process.exit(0);
}
process.exit(2);
`;

// A fake Go toolchain: `go build -trimpath -o <file> ./cmd/<name>` (in apps/api-go) writes a
// file naming the command; `go version` answers. Anything else fails.
const FAKE_GO = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'version') { console.log('go version go0.0.0-fake'); process.exit(0); }
if (process.env.SIPGES_FAKE_GO === 'fail') { console.error('fake go build failed'); process.exit(1); }
if (args[0] === 'build' && args.includes('-o') && process.cwd().replace(/\\\\/g, '/').endsWith('apps/api-go')) {
  writeFileSync(args[args.indexOf('-o') + 1], 'fake ' + args[args.length - 1] + '\\n');
  process.exit(0);
}
process.exit(2);
`;

/**
 * A checkout at `root` with builder.mjs, the updater runtime it ships, node_modules (a link to
 * this repository's, for TypeScript) and a fake pnpm and go in `<root>-bin`. Returns `build(version,
 * { failWebBuild, failGo, args })`, which runs builder.mjs like visit-kit.mjs does (`args` are
 * appended, such as `--go`) and returns its result.
 */
export async function fakeCheckout(root) {
  await mkdir(join(root, 'deploy/desktop/package'), { recursive: true });
  await mkdir(join(root, 'deploy/desktop/updater'), { recursive: true });
  await copyFile(join(repo, 'deploy/desktop/package/builder.mjs'), join(root, 'deploy/desktop/package/builder.mjs'));
  await mkdir(join(root, 'deploy/desktop/postgresql'), { recursive: true });
  for (const name of ['bundle.mjs', 'pg18.json']) await copyFile(join(repo, 'deploy/desktop/postgresql', name), join(root, 'deploy/desktop/postgresql', name));
  for (const name of UPDATER) await copyFile(join(repo, 'deploy/desktop/updater', name), join(root, 'deploy/desktop/updater', name));
  // A junction on Windows (no privilege needed); the type is ignored elsewhere.
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'junction');
  // The version builder.mjs defaults to and a release version must equal (functional-10 T15).
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'sipges-synthetic', private: true, version: '1.0.0' }));
  const bin = `${root}-bin`;
  await mkdir(bin);
  await writeFile(join(bin, 'pnpm'), FAKE_PNPM, { mode: 0o755 });
  // cmd.exe resolves `pnpm` through PATHEXT to this shim, which runs the same script with Node.
  await writeFile(join(bin, 'pnpm.cmd'), `@"${process.execPath}" "%~dp0pnpm" %*\r\n`);
  await writeFile(join(bin, 'go'), FAKE_GO, { mode: 0o755 });
  await writeFile(join(bin, 'go.cmd'), `@"${process.execPath}" "%~dp0go" %*\r\n`);
  // What `--go` copies: the Go module folder the fake go builds in, the SQL migrations and PGlite.
  await mkdir(join(root, 'apps/api-go'), { recursive: true });
  await mkdir(join(root, 'apps/api/src/platform/database/migrations'), { recursive: true });
  await writeFile(join(root, 'apps/api/src/platform/database/migrations/0001_synthetic.sql'), 'SELECT 1;\n');
  // The pinned PGlite dist --go ships for the Go move: a link to this repository's installed one.
  await mkdir(join(root, 'apps/api/node_modules/@electric-sql'), { recursive: true });
  await symlink(await realpath(join(repo, 'apps/api/node_modules/@electric-sql/pglite')), join(root, 'apps/api/node_modules/@electric-sql/pglite'), 'junction');
  /** The environment builder.mjs runs in: the fake pnpm first on PATH (whatever its key's case). */
  const env = ({ failWebBuild = false, failGo = false } = {}) => {
    const out = { ...process.env };
    const key = Object.keys(out).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
    out[key] = `${bin}${delimiter}${out[key] ?? ''}`;
    if (failWebBuild) out.SIPGES_FAKE_WEB_BUILD = 'fail';
    else delete out.SIPGES_FAKE_WEB_BUILD;
    if (failGo) out.SIPGES_FAKE_GO = 'fail';
    else delete out.SIPGES_FAKE_GO;
    return out;
  };
  const build = (version, options = {}) =>
    spawnSync(
      process.execPath,
      [join(root, 'deploy/desktop/package/builder.mjs'), '--version', version, '--out', join(root, '.data', 'desktop-packages', `sipges-${version}`), ...(options.args ?? [])],
      { cwd: root, encoding: 'utf8', env: env(options) },
    );
  return { build, env };
}

/** Every entry under `dir` without following links: files with their bytes, links with their target. */
export async function treeOf(dir) {
  const out = {};
  const walk = async (path, rel) => {
    for (const name of (await readdir(path)).sort()) {
      const full = join(path, name);
      const key = rel ? `${rel}/${name}` : name;
      const info = await lstat(full);
      if (info.isSymbolicLink()) out[key] = `link -> ${await readlink(full)}`;
      else if (info.isDirectory()) {
        out[key] = 'dir';
        await walk(full, key);
      } else out[key] = (await readFile(full)).toString('base64');
    }
  };
  await walk(dir, '');
  return out;
}

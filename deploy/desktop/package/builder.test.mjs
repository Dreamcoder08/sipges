import { test } from 'node:test';
import process from 'node:process';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, symlink, readdir, link, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = resolve('deploy/desktop/package/builder.mjs');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('CLI refuses invalid and existing destinations without changing them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-package-test-'));
  try {
    await writeFile(join(dir, 'keep'), 'untouched');
    for (const args of [['--version', 'bad', '--out', join(dir, 'new')], ['--version', '1.2.3', '--out', dir]]) {
      const result = run(...args);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^Error: /);
    }
    assert.equal(await readFile(join(dir, 'keep'), 'utf8'), 'untouched');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('public CLI validates options, versions, platform and paths without writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-package-cli-'));
  try {
    const root = join(dir, 'repo');
    const script = join(root, 'deploy/desktop/package/builder.mjs');
    await mkdir(join(root, 'deploy/desktop/package'), { recursive: true });
    await copyFile(cli, script);
    await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    const invoke = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
    const reject = (args, message) => {
      const result = invoke(...args);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `Error: ${message}\n`);
    };
    const out = '.data/desktop-packages/sipges-1.2.3';
    for (const args of [[], ['--version'], ['--bad', 'x'], ['--version', '1.2.3', '--version', '1.2.3']]) reject(args, args.length === 0 ? 'Invalid semantic version' : 'Invalid options; use --help');
    reject(['--version', '1.2.3'], 'Missing --out');
    for (const version of ['1.2', '01.2.3', '1.2.3-01', '1.2.3+', 'v1.2.3']) reject(['--version', version, '--out', out], 'Invalid semantic version');
    for (const version of ['0.0.0', '1.2.3-alpha.1+build.01']) reject(['--version', version, '--out', '/outside'], 'Output must be .data/desktop-packages/sipges-<version>');
    for (const [option, value] of [['--platform', 'not-host'], ['--arch', 'not-host']]) reject(['--version', '1.2.3', '--out', out, option, value], 'Cross-builds are not supported');
    for (const path of [root, 'apps/api', '/tmp/sipges-state', '.data/desktop-packages/../desktop-packages/sipges-1.2.3', '.data/desktop-packages/wrong']) reject(['--version', '1.2.3', '--out', path], 'Output must be .data/desktop-packages/sipges-<version>');
    assert.deepEqual((await readdir(root)).sort(), ['deploy', 'node_modules']);
    await mkdir(join(root, '.data/desktop-packages/sipges-1.2.3'), { recursive: true });
    await writeFile(join(root, out, 'keep'), 'untouched');
    reject(['--version', '1.2.3', '--out', out], 'Output already exists');
    assert.equal(await readFile(join(root, out, 'keep'), 'utf8'), 'untouched');
    const linked = join(root, '.data/desktop-packages/sipges-2.0.0');
    await symlink(join(root, out), linked, 'dir');
    reject(['--version', '2.0.0', '--out', linked], 'Output already exists');
    assert.equal(await readFile(join(root, out, 'keep'), 'utf8'), 'untouched');
    const help = invoke('--help');
    assert.equal(help.status, 0);
    assert.equal(help.stderr, '');
    assert.equal(help.stdout, 'Usage: node deploy/desktop/package/builder.mjs --version <semver> --out .data/desktop-packages/sipges-<version> [--platform <host>] [--arch <host>]\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('public CLI refuses symlinked output parents without writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-package-links-'));
  try {
    for (const which of ['.data', 'desktop-packages']) {
      const root = join(dir, which === '.data' ? 'one' : 'two');
      const script = join(root, 'deploy/desktop/package/builder.mjs');
      await mkdir(join(root, 'deploy/desktop/package'), { recursive: true });
      await copyFile(cli, script);
      await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
      const external = join(dir, `external-${which}`);
      await mkdir(external);
      if (which === 'desktop-packages') await mkdir(join(root, '.data'));
      const link = which === '.data' ? join(root, '.data') : join(root, '.data/desktop-packages');
      await symlink(external, link, 'dir');
      const result = spawnSync(process.execPath, [script, '--version', '1.2.3', '--out', '.data/desktop-packages/sipges-1.2.3'], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `Error: Unsafe output parent: ${link}\n`);
      assert.deepEqual(await readdir(external), []);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('managed entry defaults to its contained references and respects explicit configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-entry-'));
  try {
    await mkdir(join(dir, 'api/src'), { recursive: true });
    await writeFile(join(dir, 'api/src/main.js'), "console.log(process.env.SIPGES_REFERENCE_DIR);");
    const { writeManagedEntry } = await import('./builder.mjs');
    await writeManagedEntry(dir, { version: '1.2.3', platform: process.platform, arch: process.arch });
    const metadata = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8'));
    assert.equal(metadata.entry, 'start.mjs');
    assert.deepEqual(await readdir(join(dir, 'references')), []);
    for (const explicit of [undefined, join(dir, 'custom')]) {
      const env = { ...process.env };
      if (explicit === undefined) delete env.SIPGES_REFERENCE_DIR;
      else env.SIPGES_REFERENCE_DIR = explicit;
      const result = spawnSync(process.execPath, [join(dir, metadata.entry)], { encoding: 'utf8', env });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, `${explicit ?? join(dir, 'references')}\n`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('manifest rewrites do not modify hardlinked source files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-hardlinks-'));
  try {
    const api = join(dir, 'api');
    const originals = join(dir, 'originals');
    await mkdir(join(api, 'src'), { recursive: true });
    await mkdir(originals);
    await writeFile(join(api, 'src/main.ts'), 'export const value: number = 1;');
    const entries = [];
    for (const name of ['api', 'kernel', 'contracts']) {
      const root = name === 'api' ? api : join(api, 'node_modules', '@sipges', name);
      await mkdir(join(root, 'src'), { recursive: true });
      if (name !== 'api') await writeFile(join(root, 'src/index.ts'), 'export const value: number = 1;');
      const content = JSON.stringify(name === 'api' ? { type: 'module', scripts: { start: 'node src/main.ts' } } : { type: 'module', exports: { '.': './src/index.ts' } });
      const original = join(originals, `${name}.json`);
      const deployed = join(root, 'package.json');
      await writeFile(original, content, { mode: 0o640 });
      await link(original, deployed);
      entries.push({ name, original, deployed, content, before: await stat(original) });
    }
    const { compileDeployed } = await import('./builder.mjs');
    await compileDeployed(api);
    for (const entry of entries) {
      const source = await stat(entry.original);
      const deployed = await stat(entry.deployed);
      assert.equal(await readFile(entry.original, 'utf8'), entry.content, `${entry.name} source bytes`);
      assert.equal(source.ino, entry.before.ino, `${entry.name} source inode`);
      assert.notEqual(deployed.ino, source.ino, `${entry.name} deployed inode`);
      assert.equal(deployed.mode & 0o777, entry.before.mode & 0o777, `${entry.name} mode`);
      const manifest = JSON.parse(await readFile(entry.deployed, 'utf8'));
      assert.equal(entry.name === 'api' ? manifest.scripts.start : manifest.exports['.'], entry.name === 'api' ? 'node src/main.js' : './src/index.js');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('compiles deployed workspace packages for Node outside the checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-package-test-'));
  try {
    const api = join(dir, 'api');
    await mkdir(join(api, 'src'), { recursive: true });
    await writeFile(join(api, 'package.json'), JSON.stringify({ type: 'module', scripts: { start: 'node src/main.ts' } }));
    for (const name of ['kernel', 'contracts']) {
      const root = join(api, 'node_modules', '@sipges', name);
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: `@sipges/${name}`, type: 'module', exports: { '.': './src/index.ts' } }));
      await writeFile(join(root, 'src/index.ts'), `export const ${name}: string = '${name}';`);
    }
    const source = "import { kernel } from '@sipges/kernel'; import { contracts } from '@sipges/contracts'; console.log(kernel, contracts);";
    await writeFile(join(api, 'src/main.ts'), source);
    const before = spawnSync(process.execPath, [join(api, 'src/main.ts')], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(before.status, 0);
    assert.match(before.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
    const { compileDeployed } = await import('./builder.mjs');
    await compileDeployed(api);
    const after = spawnSync(process.execPath, [join(api, 'src/main.js')], { cwd: dir, encoding: 'utf8' });
    assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stdout, 'kernel contracts\n');
    assert.equal(await readFile(join(api, 'src/main.ts'), 'utf8'), source);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

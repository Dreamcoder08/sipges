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
    for (const args of [[], ['--version'], ['--bad', 'x'], ['--version', '1.2.3', '--version', '1.2.3']]) reject(args, args.length === 0 ? 'Cannot read the version in package.json; pass --version' : 'Invalid options; use --help');
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
    assert.equal(help.stdout, 'Usage: node deploy/desktop/package/builder.mjs [--version <semver>] --out .data/desktop-packages/sipges-<version> [--platform <host>] [--arch <host>] [--go]\nThe version defaults to the root package.json version; a release version must equal it, a pre-release (1.2.3-rc.1) marks a rehearsal.\n--go (opt-in) adds the Go mode: sipges-desktop, the Go API and the migrations in go/, and on Windows x64 the pinned PostgreSQL 18 in postgresql/ (downloaded once, SHA-256 verified). The default entry stays the TypeScript one.\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// functional-10 T15: the kit's version is the one /health reports (root package.json): the
// default, a release that equals it, or a rehearsal tagged as a pre-release; never another release.
test('the version comes from package.json: default, equal release or pre-release; another release is refused without writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-package-version-'));
  try {
    const root = join(dir, 'repo');
    const script = join(root, 'deploy/desktop/package/builder.mjs');
    await mkdir(join(root, 'deploy/desktop/package'), { recursive: true });
    await copyFile(cli, script);
    await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'synthetic', version: '1.2.3' }));
    const invoke = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
    const reject = (args, message) => {
      const result = invoke(...args);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `Error: ${message}\n`);
    };
    for (const version of ['1.2.4', '1.0.0', '2.0.0+build.1'])
      reject(['--version', version, '--out', `.data/desktop-packages/sipges-${version}`], `Version ${version} is not package.json's 1.2.3 (the version /health reports): build 1.2.3, or mark a rehearsal as a pre-release (1.2.3-rc.1)`);
    assert.deepEqual((await readdir(root)).sort(), ['deploy', 'node_modules', 'package.json']);
    // Without --version the package is 1.2.3: another folder name is refused, that one is checked.
    reject(['--out', '.data/desktop-packages/sipges-1.2.4'], 'Output must be .data/desktop-packages/sipges-<version>');
    await mkdir(join(root, '.data/desktop-packages/sipges-1.2.3'), { recursive: true });
    reject(['--out', '.data/desktop-packages/sipges-1.2.3'], 'Output already exists');
    // A release equal to package.json, with build metadata, and pre-releases pass the version check
    // (they stop at the existing folder, so nothing is built here).
    for (const version of ['1.2.3', '1.2.3+visit.2', '0.0.8-kit.7', '1.2.3-rc.1']) {
      await mkdir(join(root, `.data/desktop-packages/sipges-${version}`), { recursive: true });
      reject(['--version', version, '--out', `.data/desktop-packages/sipges-${version}`], 'Output already exists');
    }
    await writeFile(join(root, 'package.json'), '{"name":"synthetic"}');
    reject(['--out', '.data/desktop-packages/sipges-1.2.3'], 'Cannot read the version in package.json; pass --version');
    reject(['--version', '1.2.5', '--out', '.data/desktop-packages/sipges-1.2.5'], 'Cannot read the version in package.json, which a release version must equal');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('without --version the kit builds the package.json version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-package-default-'));
  try {
    const { fakeCheckout } = await import('./builder-helpers.mjs');
    const root = join(dir, 'repo');
    const { env } = await fakeCheckout(root);
    const out = join(root, '.data/desktop-packages/sipges-1.0.0');
    const built = spawnSync(process.execPath, [join(root, 'deploy/desktop/package/builder.mjs'), '--out', out], { cwd: root, encoding: 'utf8', env: env() });
    assert.equal(built.status, 0, built.stderr);
    assert.equal(JSON.parse(await readFile(join(out, 'metadata.json'), 'utf8')).version, '1.0.0');
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

test('desktop runtime: the package carries the updater and marks its web app as the desktop build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-runtime-'));
  try {
    await mkdir(join(dir, 'web'), { recursive: true });
    const html = '<!doctype html>\n<html lang="es">\n  <head>\n    <meta charset="UTF-8" />\n    <title>SIPGES</title>\n  </head>\n  <body></body>\n</html>\n';
    await writeFile(join(dir, 'web/index.html'), html);
    const { addDesktopRuntime } = await import('./builder.mjs');
    await addDesktopRuntime(dir);
    assert.deepEqual((await readdir(join(dir, 'updater'))).sort(), ['boot.mjs', 'launcher.mjs', 'release.mjs', 'update.mjs', 'updater.mjs']);
    for (const name of await readdir(join(dir, 'updater'))) assert.equal(await readFile(join(dir, 'updater', name), 'utf8'), await readFile(resolve('deploy/desktop/updater', name), 'utf8'));
    const marked = await readFile(join(dir, 'web/index.html'), 'utf8');
    assert.equal(marked, html.replace('  <head>\n', '  <head>\n    <meta name="sipges-desktop" content="1" />\n'));
    const help = spawnSync(process.execPath, [join(dir, 'updater/launcher.mjs'), '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^Usage: node <version>\/updater\/launcher\.mjs --install <root>/);
    await assert.rejects(addDesktopRuntime(dir), /EEXIST|already/);
    await rm(join(dir, 'updater'), { recursive: true });
    await writeFile(join(dir, 'web/index.html'), '<html><body></body></html>');
    await assert.rejects(addDesktopRuntime(dir), /^Error: web\/index\.html has no <head> to mark$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pnpm runs through cmd.exe on Windows, where it is a .cmd shim Node cannot start directly', async () => {
  const { commandFor } = await import('./builder.mjs');
  const args = ['--filter', '@sipges/api', 'deploy', '--prod', '--legacy', 'C:\\Users\\Ana María\\sipges\\.data\\desktop-packages\\sipges-1.0.0\\api'];
  assert.deepEqual(commandFor('pnpm', args, 'linux', undefined), { file: 'pnpm', args, options: {} });
  assert.deepEqual(commandFor('pnpm', args, 'win32', 'C:\\Windows\\system32\\cmd.exe'), {
    file: 'C:\\Windows\\system32\\cmd.exe',
    args: ['/d', '/s', '/c', '"pnpm --filter @sipges/api deploy --prod --legacy "C:\\Users\\Ana María\\sipges\\.data\\desktop-packages\\sipges-1.0.0\\api""'],
    options: { windowsVerbatimArguments: true },
  });
  assert.equal(commandFor('pnpm', ['build'], 'win32', undefined).file, 'cmd.exe');
  for (const unsafe of ['C:\\a"b', 'C:\\100%\\x']) assert.throws(() => commandFor('pnpm', [unsafe], 'win32', 'cmd.exe'), /^Error: Cannot pass .+ to cmd\.exe$/);
});

// F2: a build that fails half-way leaves its folder (failed builds are retained); only a build
// that finished writes the completion file, last, so the visit kit can tell the two apart.
test('a finished build ends with its completion file; a failed one has the marker and no completion file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-package-complete-'));
  try {
    const { fakeCheckout } = await import('./builder-helpers.mjs');
    const { PACKAGE_MARKER, PACKAGE_MARKER_TEXT, PACKAGE_COMPLETE } = await import('./builder.mjs');
    assert.deepEqual([PACKAGE_MARKER, PACKAGE_MARKER_TEXT, PACKAGE_COMPLETE], ['.sipges-desktop-package', 'Generated package; failed builds are retained.\n', '.sipges-package-complete']);
    const root = join(dir, 'repo');
    const { build } = await fakeCheckout(root);
    const failed = build('1.0.0', { failWebBuild: true });
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /^Error: pnpm failed: 1\n$/m);
    const half = join(root, '.data/desktop-packages/sipges-1.0.0');
    assert.equal(await readFile(join(half, PACKAGE_MARKER), 'utf8'), PACKAGE_MARKER_TEXT);
    assert.deepEqual((await readdir(half)).sort(), [PACKAGE_MARKER, '.sipges-package-building', 'api']);
    // The first clean build of another version (preserved): exit 0, the completion file last.
    const done = build('1.0.0-rc.1');
    assert.equal(done.status, 0, done.stderr);
    const full = join(root, '.data/desktop-packages/sipges-1.0.0-rc.1');
    assert.match(done.stdout, new RegExp(`Package created: ${full.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n$`));
    assert.equal(await readFile(join(full, PACKAGE_COMPLETE), 'utf8'), 'Build finished.\n');
    const metadata = JSON.parse(await readFile(join(full, 'metadata.json'), 'utf8'));
    assert.equal(metadata.version, '1.0.0-rc.1');
    const completed = (await stat(join(full, PACKAGE_COMPLETE))).mtimeMs;
    for (const later of ['metadata.json', 'web/index.html', 'updater/updater.mjs'])
      assert.ok((await stat(join(full, later))).mtimeMs <= completed, `${later} written after the completion file`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// T72c: the Go mode is opt-in. Without --go the package is exactly what it was (no go/, no
// postgresql/, no `go` in metadata.json); with it the Go binaries and the migrations are added,
// and the pinned PostgreSQL only on Windows x64 (deploy/desktop/postgresql). Skipped on Windows,
// where --go would download the real 343 MB zip: the workflow's go-mode job builds it there.
test('--go adds the Go binaries and migrations; without it the package is unchanged', { skip: process.platform === 'win32' && 'the go-mode job builds --go on Windows with the real bundle' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-package-go-'));
  try {
    const { fakeCheckout } = await import('./builder-helpers.mjs');
    const root = join(dir, 'repo');
    const { build } = await fakeCheckout(root);
    const plain = build('1.0.0-rc.1');
    assert.equal(plain.status, 0, plain.stderr);
    const plainDir = join(root, '.data/desktop-packages/sipges-1.0.0-rc.1');
    const plainEntries = (await readdir(plainDir)).sort();
    assert.equal(plainEntries.includes('go'), false);
    assert.equal(plainEntries.includes('postgresql'), false);
    assert.equal('go' in JSON.parse(await readFile(join(plainDir, 'metadata.json'), 'utf8')), false);

    const go = build('1.0.0-rc.2', { args: ['--go'] });
    assert.equal(go.status, 0, go.stderr);
    const goDir = join(root, '.data/desktop-packages/sipges-1.0.0-rc.2');
    assert.deepEqual((await readdir(goDir)).sort(), [...plainEntries, 'go'].sort());
    assert.deepEqual((await readdir(join(goDir, 'go'))).sort(), ['api', 'migrations', 'sipges-desktop']);
    assert.equal(await readFile(join(goDir, 'go/sipges-desktop'), 'utf8'), 'fake ./cmd/sipges-desktop\n');
    assert.equal(await readFile(join(goDir, 'go/api'), 'utf8'), 'fake ./cmd/api\n');
    assert.equal(await readFile(join(goDir, 'go/migrations/0001_synthetic.sql'), 'utf8'), 'SELECT 1;\n');
    const metadata = JSON.parse(await readFile(join(goDir, 'metadata.json'), 'utf8'));
    assert.deepEqual(metadata.go, { entry: 'go/sipges-desktop', api: 'go/api', migrations: 'go/migrations', postgresql: null });
    assert.equal(metadata.entry, 'start.mjs', 'the default entry stays the TypeScript one');
    assert.match(go.stdout, new RegExp(`No PostgreSQL bundle for ${process.platform}-${process.arch}: the Go mode there needs SIPGES_PG_BIN`));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('--go takes no value, and a failed go build leaves no completion file', { skip: process.platform === 'win32' && 'the go-mode job builds --go on Windows' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-package-go-fail-'));
  try {
    const { fakeCheckout } = await import('./builder-helpers.mjs');
    const { PACKAGE_COMPLETE } = await import('./builder.mjs');
    const root = join(dir, 'repo');
    const { build } = await fakeCheckout(root);
    const valued = build('1.0.0-rc.3', { args: ['--go', 'yes'] });
    assert.equal(valued.status, 1);
    assert.match(valued.stderr, /^Error: Invalid options; use --help\n$/);
    const failed = build('1.0.0-rc.4', { args: ['--go'], failGo: true });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /^Error: go failed: 1\n$/m);
    const entries = await readdir(join(root, '.data/desktop-packages/sipges-1.0.0-rc.4'));
    assert.equal(entries.includes(PACKAGE_COMPLETE), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

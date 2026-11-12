import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import process from 'node:process';
import console from 'node:console';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const inside = (parent, child) => { const r = relative(parent, child); return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r)); };

async function walk(root, visit) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walk(path, visit);
    else await visit(path, entry);
  }
}

async function rejectExternalLinks(root) {
  const canonical = await realpath(root);
  await walk(root, async (path, entry) => {
    if (entry.isSymbolicLink() && !inside(canonical, await realpath(path))) throw new Error(`External symlink: ${path}`);
  });
}

async function compileSource(root) {
  await walk(root, async (path, entry) => {
    if (!entry.isFile() || !path.endsWith('.ts') || path.endsWith('.d.ts')) return;
    const source = await readFile(path, 'utf8');
    const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, rewriteRelativeImportExtensions: true }, fileName: path, reportDiagnostics: true });
    const errors = result.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error) ?? [];
    if (errors.length) throw new Error(`Cannot transpile ${path}: ${ts.flattenDiagnosticMessageText(errors[0].messageText, '\n')}`);
    await writeFile(path.slice(0, -3) + '.js', result.outputText, { flag: 'wx' });
  });
}

function rewriteExports(value) {
  if (typeof value === 'string') return value.replace(/\.ts$/, '.js');
  if (Array.isArray(value)) return value.map(rewriteExports);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteExports(item)]));
  return value;
}

async function replaceManifest(path, pkg) {
  const mode = (await stat(path)).mode & 0o7777;
  const temporary = join(dirname(path), `.package-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(pkg, null, 2)}\n`, { flag: 'wx', mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

export async function compileDeployed(api) {
  await rejectExternalLinks(api);
  await compileSource(join(api, 'src'));
  for (const name of ['kernel', 'contracts']) {
    const root = await realpath(join(api, 'node_modules', '@sipges', name));
    if (!inside(await realpath(api), root)) throw new Error(`External workspace package: ${name}`);
    await compileSource(join(root, 'src'));
    const path = join(root, 'package.json');
    const pkg = JSON.parse(await readFile(path, 'utf8'));
    pkg.exports = rewriteExports(pkg.exports);
    if (pkg.main) pkg.main = rewriteExports(pkg.main);
    await replaceManifest(path, pkg);
  }
  const path = join(api, 'package.json');
  const pkg = JSON.parse(await readFile(path, 'utf8'));
  pkg.scripts.start = 'node src/main.js';
  await replaceManifest(path, pkg);
}

export async function writeManagedEntry(destination, metadata) {
  await mkdir(join(destination, 'references'), { mode: 0o700 });
  await writeFile(join(destination, 'start.mjs'), "import { fileURLToPath } from 'node:url';\nprocess.env.SIPGES_REFERENCE_DIR ??= fileURLToPath(new URL('./references', import.meta.url));\nawait import('./api/src/main.js');\n", { flag: 'wx' });
  await writeFile(join(destination, 'metadata.json'), `${JSON.stringify({ ...metadata, node: '>=24', entry: 'start.mjs' }, null, 2)}\n`, { flag: 'wx' });
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repo, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.status}`);
}

async function outputPath(root, out, version) {
  const base = join(root, '.data', 'desktop-packages');
  const destination = resolve(out);
  if (out.split(/[\\/]/).includes('..') || dirname(destination) !== base || destination !== join(base, `sipges-${version}`)) throw new Error('Output must be .data/desktop-packages/sipges-<version>');
  for (const path of [join(root, '.data'), base]) {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe output parent: ${path}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try { await lstat(destination); throw new Error('Output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return destination;
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') { console.log('Usage: node deploy/desktop/package/builder.mjs --version <semver> --out .data/desktop-packages/sipges-<version> [--platform <host>] [--arch <host>]'); return; }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--version', '--out', '--platform', '--arch'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--') || options[key]) throw new Error('Invalid options; use --help');
    options[key] = args[i + 1];
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/.test(options['--version'] ?? '')) throw new Error('Invalid semantic version');
  if (!options['--out']) throw new Error('Missing --out');
  if ((options['--platform'] ?? process.platform) !== process.platform || (options['--arch'] ?? process.arch) !== process.arch) throw new Error('Cross-builds are not supported');
  const destination = await outputPath(repo, options['--out'], options['--version']);
  await mkdir(join(repo, '.data'), { mode: 0o700, recursive: true });
  await mkdir(join(repo, '.data', 'desktop-packages'), { mode: 0o700, recursive: true });
  await outputPath(repo, destination, options['--version']);
  await mkdir(destination, { mode: 0o700 });
  await writeFile(join(destination, '.sipges-desktop-package'), 'Generated package; failed builds are retained.\n', { flag: 'wx' });
  run('pnpm', ['--filter', '@sipges/api', 'deploy', '--prod', '--legacy', join(destination, 'api')]);
  run('pnpm', ['--filter', '@sipges/web', 'build']);
  await cp(join(repo, 'apps/web/dist'), join(destination, 'web'), { recursive: true, errorOnExist: true, force: false });
  await rejectExternalLinks(destination);
  await compileDeployed(join(destination, 'api'));
  await writeManagedEntry(destination, { version: options['--version'], platform: process.platform, arch: process.arch });
  console.log(`Package created: ${destination}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}

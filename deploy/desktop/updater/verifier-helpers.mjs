import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createRelease } from './release.mjs';

export const noop = async () => {};
export async function withTemp(fn) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sipges-probe-')));
  try {
    return await fn(dir);
  } finally {
    await chmodTree(dir).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}
async function chmodTree(dir) {
  for (const e of await readdir(dir, { withFileTypes: true }))
    if (e.isDirectory()) {
      await chmod(join(dir, e.name), 0o755).catch(() => {});
    }
}
export const newPair = () => generateKeyPairSync('ed25519');
export const publicPem = (pair) => pair.publicKey.export({ type: 'spki', format: 'pem' });
export async function put(path, content, mode) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, mode ? { mode } : undefined);
}
export async function makePackage(dir, version, start) {
  const metadata = {
    version,
    platform: process.platform,
    arch: process.arch,
    node: '>=24',
    entry: 'start.mjs',
  };
  await put(join(dir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  await put(join(dir, 'start.mjs'), start ?? `// synthetic entry ${version}\n`);
  await put(join(dir, 'api/src/main.js'), `export const version = '${version}';\n`);
  await put(join(dir, 'web/index.html'), `<!doctype html><title>SIPGES ${version}</title>\n`);
  await put(
    join(dir, 'api/node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js'),
    'export {};\n',
  );
  await mkdir(join(dir, 'references'), { recursive: true });
  await symlink('.pnpm/dep@1.0.0/node_modules/dep', join(dir, 'api/node_modules/dep'), 'dir');
}
export async function makeState(dir) {
  const page = Buffer.alloc(8192);
  for (let i = 0; i < page.length; i += 1) page[i] = (i * 31) % 251;
  await put(join(dir, 'pglite/PG_VERSION'), '17\n');
  await put(join(dir, 'pglite/base/1/16384'), page);
  await put(join(dir, 'uploads/synthetic-project/evidence.pdf'), '%PDF-synthetic\n');
  await put(join(dir, 'data-key'), 'c3ludGhldGljLWtleS1mb3ItdGVzdHMtb25seS0wMDA=\n', 0o600);
  await put(join(dir, 'admin-password'), 'synthetic-admin-password\n', 0o600);
}
export async function snapshot(root, skip = () => false) {
  const out = {};
  const walk = async (dir, prefix) => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (skip(rel)) continue;
      const info = await lstat(path);
      const mode = (info.mode & 0o777).toString(8);
      if (info.isSymbolicLink()) out[rel] = `link ${await readlink(path)}`;
      else if (info.isDirectory()) {
        out[rel] = `dir ${mode}`;
        await walk(path, rel);
      } else if (info.isFile())
        out[rel] = `file ${mode} ${createHash('sha256')
          .update(await readFile(path))
          .digest('hex')}`;
      else out[rel] = `special ${mode}`;
    }
  };
  await walk(root, '');
  return out;
}
export const siblings = async (state) =>
  (await readdir(dirname(state))).filter((n) => n.startsWith(`${basename(state)}.`)).sort();
export const logLines = async (root) =>
  (await readFile(join(root, 'update.log'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
let serial = 0;
export function releases(dir, pair, { make = makePackage, parent } = {}) {
  return async (version, options = {}) => {
    serial += 1;
    const pkg = join(dir, `package-${serial}`);
    const release = join(
      options.parent ?? parent ?? dir,
      options.name ?? `release-${version}-${serial}`,
    );
    await make(pkg, version, options.start);
    const signer = options.signer ?? pair;
    await createRelease({
      packageDir: pkg,
      releaseDir: release,
      privateKey: signer.privateKey,
      minimumPrevious: null,
      notes: options.notes ?? null,
    });
    return release;
  };
}

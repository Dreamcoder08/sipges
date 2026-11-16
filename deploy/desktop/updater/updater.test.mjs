// Synthetic tests of the signed update transaction. Migration and readiness are injected; no
// server is booted. Every key, package, release and state folder is generated in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRelease } from './release.mjs';
import {
  STEPS,
  findUpdate,
  inspectInstall,
  install,
  readCurrent,
  recover,
  update,
} from './updater.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const updateCli = join(here, 'update.mjs');
const releaseCli = join(here, 'release.mjs');
const node = (...args) => spawnSync(process.execPath, args, { encoding: 'utf8' });
const noop = async () => {};

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-updater-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const keys = () => generateKeyPairSync('ed25519');
const publicPem = (pair) => pair.publicKey.export({ type: 'spki', format: 'pem' });

async function put(path, content, mode) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, mode ? { mode } : undefined);
}

/** A synthetic package shaped like the builder output, with one internal directory link. */
async function makePackage(dir, version) {
  const metadata = {
    version,
    platform: process.platform,
    arch: process.arch,
    node: '>=24',
    entry: 'start.mjs',
  };
  await put(join(dir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  await put(
    join(dir, '.sipges-desktop-package'),
    'Generated package; failed builds are retained.\n',
  );
  await put(join(dir, 'start.mjs'), `// synthetic entry ${version}\n`);
  await put(join(dir, 'api/src/main.js'), `export const version = '${version}';\n`);
  await put(join(dir, 'web/index.html'), `<!doctype html><title>SIPGES ${version}</title>\n`);
  await put(
    join(dir, 'api/node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js'),
    'export {};\n',
  );
  await mkdir(join(dir, 'references'), { recursive: true });
  await symlink('.pnpm/dep@1.0.0/node_modules/dep', join(dir, 'api/node_modules/dep'), 'dir');
}

/** A synthetic state folder with the four entries a real one holds. */
async function makeState(dir) {
  const page = Buffer.alloc(8192);
  for (let i = 0; i < page.length; i += 1) page[i] = (i * 31) % 251;
  await put(join(dir, 'pglite/PG_VERSION'), '17\n');
  await put(join(dir, 'pglite/base/1/16384'), page);
  await put(join(dir, 'uploads/synthetic-project/evidence.pdf'), '%PDF-synthetic\n');
  await put(join(dir, 'data-key'), 'c3ludGhldGljLWtleS1mb3ItdGVzdHMtb25seS0wMDA=\n', 0o600);
  await put(join(dir, 'admin-password'), 'synthetic-admin-password\n', 0o600);
}

/** Path -> type, mode and content hash (or link target), without following links. */
async function snapshot(root) {
  const out = {};
  const walk = async (dir, prefix) => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(path);
      const mode = (info.mode & 0o777).toString(8);
      if (info.isSymbolicLink()) out[rel] = `link ${await readlink(path)}`;
      else if (info.isDirectory()) {
        out[rel] = `dir ${mode}`;
        await walk(path, rel);
      } else
        out[rel] = `file ${mode} ${createHash('sha256')
          .update(await readFile(path))
          .digest('hex')}`;
    }
  };
  await walk(root, '');
  return out;
}

const siblings = async (state) =>
  (await readdir(dirname(state))).filter((n) => n.startsWith(`${basename(state)}.`)).sort();

const logLines = async (root) =>
  (await readFile(join(root, 'update.log'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

let serial = 0;
async function fixture(dir, from = '1.0.0') {
  const pair = keys();
  const root = join(dir, 'install');
  const state = join(dir, 'state');
  await makeState(state);
  const releaseOf = async (version, options = {}) => {
    serial += 1;
    const pkg = join(dir, `package-${serial}`);
    const release = join(dir, `release-${serial}`);
    await makePackage(pkg, version);
    await createRelease({
      packageDir: pkg,
      releaseDir: release,
      privateKey: options.key ?? pair.privateKey,
      minimumPrevious: options.minimumPrevious ?? null,
    });
    return release;
  };
  await install({
    root,
    release: await releaseOf(from),
    stateDir: state,
    trustKey: publicPem(pair),
  });
  return { root, state, pair, releaseOf };
}

const refused = (pattern) => (error) => {
  assert.equal(error.code, 'REFUSED', error.message);
  assert.match(error.message, pattern);
  return true;
};
const rolledBack = (pattern) => (error) => {
  assert.equal(error.code, 'ROLLED_BACK', error.message);
  assert.match(error.message, pattern);
  return true;
};

test('rule 1: a bad signature or any mismatching file is refused and nothing changes', () =>
  withTemp(async (dir) => {
    const { root, state, releaseOf } = await fixture(dir);
    const tampered = [
      [async () => releaseOf('1.1.0', { key: keys().privateKey }), /signature does not match/],
      [
        async () => {
          const r = await releaseOf('1.1.0');
          await writeFile(join(r, 'package/api/src/main.js'), 'tampered\n');
          return r;
        },
        /^File does not match the signed release: api\/src\/main\.js$/,
      ],
      [
        async () => {
          const r = await releaseOf('1.1.0');
          await writeFile(join(r, 'package/api/src/extra.js'), 'unlisted\n');
          return r;
        },
        /does not match its manifest: unlisted api\/src\/extra\.js/,
      ],
      [
        async () => {
          const r = await releaseOf('1.1.0');
          await rm(join(r, 'package/web/index.html'));
          return r;
        },
        /does not match its manifest: missing web\/index\.html/,
      ],
      [
        async () => {
          const r = await releaseOf('1.1.0');
          const text = await readFile(join(r, 'release.json'), 'utf8');
          await writeFile(join(r, 'release.json'), text.replace('"1.1.0"', '"1.2.0"'));
          return r;
        },
        /signature does not match/,
      ],
    ];
    const pointer = await readFile(join(root, 'current.json'));
    const versions = await snapshot(join(root, 'versions'));
    const stateBefore = await snapshot(state);
    for (const [make, pattern] of tampered) {
      const calls = [];
      const spy = async ({ stateDir }) => calls.push(stateDir);
      await assert.rejects(
        update({ root, release: await make(), migrate: spy, ready: spy }),
        refused(pattern),
      );
      assert.deepEqual(calls, []);
      assert.deepEqual(await readFile(join(root, 'current.json')), pointer);
      assert.deepEqual(await snapshot(join(root, 'versions')), versions);
      assert.deepEqual(await snapshot(state), stateBefore);
      assert.equal((await readCurrent(root)).version, '1.0.0');
    }
    const log = await logLines(root);
    assert.equal(log.filter((entry) => entry.event === 'refused').length, tampered.length);
  }));

test('rule 2: a release that is not newer, or needs a newer installed version, is refused', () =>
  withTemp(async (dir) => {
    const { root, releaseOf } = await fixture(dir);
    const pointer = await readFile(join(root, 'current.json'));
    for (const version of ['1.0.0', '0.9.9', '1.0.0-rc.1', '1.0.0+build.2']) {
      await assert.rejects(
        update({ root, release: await releaseOf(version), migrate: noop, ready: noop }),
        refused(
          new RegExp(
            `^Version ${version.replace(/[.+]/g, '\\$&')} is not newer than the installed 1\\.0\\.0$`,
          ),
        ),
      );
    }
    await assert.rejects(
      update({
        root,
        release: await releaseOf('1.1.0', { minimumPrevious: '1.0.1' }),
        migrate: noop,
        ready: noop,
      }),
      refused(/^Version 1\.1\.0 requires at least 1\.0\.1 installed; found 1\.0\.0$/),
    );
    assert.deepEqual(await readFile(join(root, 'current.json')), pointer);
    assert.deepEqual(await readdir(join(root, 'versions')), ['1.0.0']);
    const result = await update({
      root,
      release: await releaseOf('1.0.1-local.1'),
      migrate: noop,
      ready: noop,
    });
    assert.deepEqual([result.from, result.to], ['1.0.0', '1.0.1-local.1']);
  }));

const driver = `import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
const [updater, root, release, crashAt] = process.argv.slice(2);
const { update } = await import(updater);
await update({
  root,
  release,
  migrate: async ({ stateDir }) => writeFile(join(stateDir, 'pglite', 'migrated'), 'synthetic'),
  ready: async () => {},
  onStep: (step) => { if (step === crashAt) process.exit(70); },
});
`;

test('rule 3: a crash after any step leaves a complete version current, and recovery is consistent', () =>
  withTemp(async (dir) => {
    assert.deepEqual(STEPS, [
      'locked',
      'verified',
      'staged',
      'installed',
      'state-copied',
      'rehearsed',
      'migrated',
      'switched',
      'ready',
      'committed',
    ]);
    const script = join(dir, 'scripts', 'crash-driver.mjs');
    await put(script, driver);
    for (const step of STEPS.filter((s) => s !== 'rehearsed')) {
      const work = join(dir, step);
      const { root, state, releaseOf } = await fixture(work);
      const before = await snapshot(state);
      const release = await releaseOf('1.1.0');
      const run = node(script, pathToFileURL(join(here, 'updater.mjs')).href, root, release, step);
      assert.equal(run.status, 70, `crash at ${step}: ${run.stderr}`);
      const switched = STEPS.indexOf(step) >= STEPS.indexOf('switched');
      const crashed = await inspectInstall(root);
      assert.equal(crashed.complete, true, `${step}: ${crashed.reason}`);
      assert.equal(crashed.version, switched ? '1.1.0' : '1.0.0', step);
      const recovered = await recover({ root });
      const kept = step === 'committed';
      assert.equal(recovered.version, kept ? '1.1.0' : '1.0.0', step);
      const after = await inspectInstall(root);
      assert.equal(after.complete, true, `${step}: ${after.reason}`);
      assert.equal(after.version, kept ? '1.1.0' : '1.0.0', step);
      const expected = kept
        ? { ...before, 'pglite/migrated': (await snapshot(state))['pglite/migrated'] }
        : before;
      assert.deepEqual(await snapshot(state), expected, step);
      const next = await update({
        root,
        release: await releaseOf('1.2.0'),
        migrate: noop,
        ready: noop,
      });
      assert.equal(next.to, '1.2.0', step);
    }
  }));

test('rule 3: the pointer is replaced by one rename and no temporary file remains', () =>
  withTemp(async (dir) => {
    const { root, releaseOf } = await fixture(dir);
    const before = await stat(join(root, 'current.json'));
    const seen = [];
    await update({
      root,
      release: await releaseOf('1.1.0'),
      migrate: noop,
      ready: noop,
      onStep: async (step) => {
        if (step === 'migrated' || step === 'switched')
          seen.push((await stat(join(root, 'current.json'))).ino);
      },
    });
    assert.equal(seen[0], before.ino);
    assert.notEqual(seen[1], before.ino);
    assert.deepEqual((await readdir(root)).sort(), [
      'current.json',
      'install.json',
      'update.log',
      'versions',
    ]);
    assert.deepEqual((await readdir(join(root, 'versions'))).sort(), ['1.0.0', '1.1.0']);
  }));

test('rule 4: the state folder is byte-identical after any update except for the dated copy beside it', () =>
  withTemp(async (dir) => {
    const scenarios = [
      [
        'success',
        async ({ stateDir }) => void (await readFile(join(stateDir, 'data-key'))),
        noop,
        null,
      ],
      ['refused', noop, noop, 'REFUSED'],
      [
        'migration fails',
        async ({ stateDir }) => {
          await writeFile(join(stateDir, 'pglite/base/1/16384'), 'half-migrated');
          await writeFile(join(stateDir, 'uploads/new.bin'), 'x');
          throw new Error('synthetic migration failure');
        },
        noop,
        'ROLLED_BACK',
      ],
      [
        'readiness fails',
        async ({ stateDir }) => writeFile(join(stateDir, 'pglite/PG_VERSION'), '18\n'),
        async () => {
          throw new Error('synthetic readiness failure');
        },
        'ROLLED_BACK',
      ],
    ];
    for (const [name, migrate, ready, code] of scenarios) {
      const { root, state, releaseOf } = await fixture(join(dir, name.replace(/ /g, '-')));
      const before = await snapshot(state);
      const release = await releaseOf(
        '1.1.0',
        name === 'refused' ? { key: keys().privateKey } : {},
      );
      const attempt = update({
        root,
        release,
        migrate,
        ready,
        now: () => new Date('2026-11-11T10:15:30Z'),
      });
      if (code) await assert.rejects(attempt, (error) => error.code === code);
      else await attempt;
      assert.deepEqual(await snapshot(state), before, name);
      const names = await siblings(state);
      if (code === 'REFUSED') assert.deepEqual(names, [], name);
      else {
        const copy = names.filter((n) =>
          /^state\.pre-update-20261111T101530Z-1\.0\.0-to-1\.1\.0$/.test(n),
        );
        assert.equal(copy.length, 1, `${name}: ${names}`);
        assert.deepEqual(await snapshot(join(dirname(state), copy[0])), before, name);
        const others = names.filter((n) => n !== copy[0]);
        assert.deepEqual(others, code ? ['state.failed-20261111T101530Z-1.1.0'] : [], name);
      }
    }
  }));

test('rule 5: a failed readiness check switches back to the previous version and logs it', () =>
  withTemp(async (dir) => {
    const { root, releaseOf } = await fixture(dir);
    const seen = [];
    await assert.rejects(
      update({
        root,
        release: await releaseOf('1.1.0'),
        migrate: noop,
        ready: async ({ versionDir, version }) => {
          seen.push([version, (await readCurrent(root)).dir === versionDir]);
          throw new Error('synthetic readiness failure');
        },
      }),
      rolledBack(
        /^Update to 1\.1\.0 failed at ready and was rolled back to 1\.0\.0: synthetic readiness failure$/,
      ),
    );
    assert.deepEqual(seen, [['1.1.0', true]]);
    const current = await inspectInstall(root);
    assert.deepEqual([current.version, current.complete], ['1.0.0', true]);
    const last = (await logLines(root)).at(-1);
    assert.deepEqual(
      [last.event, last.from, last.to, last.step, last.reason],
      ['rolled-back', '1.0.0', '1.1.0', 'ready', 'synthetic readiness failure'],
    );
    assert.equal(typeof last.time, 'string');
  }));

test('rule 6: a failed migration rolls back and restores the state folder from the pre-update copy', () =>
  withTemp(async (dir) => {
    const { root, state, releaseOf } = await fixture(dir);
    const before = await snapshot(state);
    const readied = [];
    await assert.rejects(
      update({
        root,
        release: await releaseOf('1.1.0'),
        migrate: async ({ stateDir }) => {
          assert.equal(stateDir, state);
          await writeFile(join(stateDir, 'pglite/base/1/16384'), 'half-migrated');
          await rm(join(stateDir, 'uploads/synthetic-project/evidence.pdf'));
          throw new Error('synthetic migration failure');
        },
        ready: async () => readied.push(true),
      }),
      rolledBack(
        /^Update to 1\.1\.0 failed at migrate and was rolled back to 1\.0\.0: synthetic migration failure$/,
      ),
    );
    assert.deepEqual(readied, []);
    assert.deepEqual(await snapshot(state), before);
    assert.equal((await readCurrent(root)).version, '1.0.0');
    const last = (await logLines(root)).at(-1);
    assert.deepEqual([last.event, last.step], ['rolled-back', 'migrate']);
  }));

test('rule 7: an old plain package is adopted in place and the first update rehearses on a copy', () =>
  withTemp(async (dir) => {
    const pair = keys();
    const legacy = join(dir, 'old-install');
    const state = join(dir, 'state');
    await makePackage(legacy, '0.9.0');
    await makeState(state);
    const legacyBefore = await snapshot(legacy);
    const stateBefore = await snapshot(state);
    const release = join(dir, 'release-1.0.0');
    await makePackage(join(dir, 'pkg-1.0.0'), '1.0.0');
    await createRelease({
      packageDir: join(dir, 'pkg-1.0.0'),
      releaseDir: release,
      privateKey: pair.privateKey,
    });

    const root = join(dir, 'install');
    await assert.rejects(
      update({
        root,
        release,
        adopt: { dir: legacy, stateDir: state },
        migrate: noop,
        ready: noop,
      }),
      refused(/^Updates are disabled: the installed version has no update key$/),
    );

    const failing = join(dir, 'failing-install');
    const touched = [];
    await assert.rejects(
      update({
        root: failing,
        release,
        adopt: { dir: legacy, stateDir: state },
        trustKey: publicPem(pair),
        migrate: async ({ stateDir }) => {
          touched.push(stateDir);
          throw new Error('synthetic migration failure');
        },
        ready: noop,
      }),
      rolledBack(
        /^Update to 1\.0\.0 failed at rehearsal on a copy of the state folder; the state folder was not touched: synthetic migration failure$/,
      ),
    );
    assert.equal(touched.length, 1);
    assert.notEqual(touched[0], state);
    assert.match(basename(touched[0]), /^state\.rehearsal-\d{8}T\d{6}Z-1\.0\.0$/);
    assert.deepEqual(await readCurrent(failing), { version: '0.9.0', dir: legacy, adopted: true });
    assert.deepEqual(await snapshot(state), stateBefore);

    const calls = [];
    const record =
      (kind, expected = '1.0.0') =>
      async ({ stateDir, versionDir }) => {
        calls.push([
          kind,
          stateDir === state
            ? 'real'
            : basename(stateDir).replace(/-\d{8}T\d{6}Z-([^-]+)(-\d+)?$/, '-$1'),
        ]);
        if (stateDir !== state) assert.deepEqual(await snapshot(state), stateBefore);
        assert.equal(versionDir, join(root, 'versions', expected));
      };
    const result = await update({
      root,
      release,
      adopt: { dir: legacy, stateDir: state },
      trustKey: publicPem(pair),
      migrate: record('migrate'),
      ready: record('ready'),
    });
    assert.deepEqual([result.from, result.to], ['0.9.0', '1.0.0']);
    assert.deepEqual(calls, [
      ['migrate', 'state.rehearsal-1.0.0'],
      ['ready', 'state.rehearsal-1.0.0'],
      ['migrate', 'real'],
      ['ready', 'real'],
    ]);
    assert.deepEqual(await snapshot(legacy), legacyBefore);
    assert.deepEqual(await snapshot(state), stateBefore);
    assert.deepEqual(await readdir(join(root, 'versions')), ['1.0.0']);
    assert.equal((await inspectInstall(root)).complete, true);

    const next = join(dir, 'release-1.1.0');
    await makePackage(join(dir, 'pkg-1.1.0'), '1.1.0');
    await createRelease({
      packageDir: join(dir, 'pkg-1.1.0'),
      releaseDir: next,
      privateKey: pair.privateKey,
    });
    calls.length = 0;
    const second = await update({
      root,
      release: next,
      migrate: record('migrate', '1.1.0'),
      ready: record('ready', '1.1.0'),
    });
    assert.equal(second.to, '1.1.0');
    assert.deepEqual(calls, [
      ['migrate', 'real'],
      ['ready', 'real'],
    ]);
  }));

test('end to end: N to N+1 succeeds; a forced failed update ends with N running and the state intact', () =>
  withTemp(async (dir) => {
    const pair = keys();
    const keyFile = join(dir, 'keys', 'synthetic-signing.pem');
    await put(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), 0o600);
    const releaseOf = async (version) => {
      await makePackage(join(dir, `pkg-${version}`), version);
      const out = join(dir, `release-${version}`);
      const run = node(
        releaseCli,
        '--package',
        join(dir, `pkg-${version}`),
        '--out',
        out,
        '--key',
        keyFile,
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, `Release ${version} signed: ${out}\n`);
      return out;
    };
    const [n, n1] = [await releaseOf('1.0.0'), await releaseOf('1.1.0')];
    for (const fails of [false, true]) {
      const work = join(dir, fails ? 'failing' : 'passing');
      const state = join(work, 'state');
      await makeState(state);
      const root = join(work, 'install');
      await install({ root, release: n, stateDir: state, trustKey: publicPem(pair) });
      const before = await snapshot(state);
      const attempt = update({
        root,
        release: n1,
        migrate: async ({ stateDir }) => void (await readFile(join(stateDir, 'pglite/PG_VERSION'))),
        ready: async ({ versionDir }) => {
          const metadata = JSON.parse(await readFile(join(versionDir, 'metadata.json'), 'utf8'));
          if (fails) throw new Error(`synthetic: ${metadata.version} did not answer`);
        },
      });
      if (fails)
        await assert.rejects(
          attempt,
          rolledBack(/rolled back to 1\.0\.0: synthetic: 1\.1\.0 did not answer$/),
        );
      else assert.deepEqual(await attempt.then((r) => [r.from, r.to]), ['1.0.0', '1.1.0']);
      const running = await inspectInstall(root);
      assert.deepEqual([running.version, running.complete], [fails ? '1.0.0' : '1.1.0', true]);
      assert.deepEqual(await snapshot(state), before);
    }
  }));

test('CLI: usage, refusals and recovery never boot a server', () =>
  withTemp(async (dir) => {
    const { root, pair, releaseOf } = await fixture(dir);
    const help = node(updateCli, '--help');
    assert.equal(help.status, 0);
    assert.match(
      help.stdout,
      /^Usage: node deploy\/desktop\/updater\/update\.mjs --install <root> --release <dir>/,
    );
    for (const args of [
      [],
      ['--install'],
      ['--bogus', 'x'],
      ['--install', root, '--install', root],
    ]) {
      const run = node(updateCli, ...args);
      assert.equal(run.status, 1);
      assert.equal(run.stdout, '');
      assert.match(run.stderr, /^Error: (Missing --install|Invalid options; use --help)\n$/);
    }
    const tampered = await releaseOf('1.1.0');
    await writeFile(join(tampered, 'package/start.mjs'), 'tampered\n');
    const refusedRun = node(updateCli, '--install', root, '--release', tampered);
    assert.deepEqual(
      [refusedRun.status, refusedRun.stdout, refusedRun.stderr],
      [1, '', 'Error: File does not match the signed release: start.mjs\n'],
    );
    const same = node(updateCli, '--install', root, '--release', await releaseOf('1.0.0'));
    assert.deepEqual(
      [same.status, same.stderr],
      [1, 'Error: Version 1.0.0 is not newer than the installed 1.0.0\n'],
    );
    const nothing = node(updateCli, '--install', root, '--recover');
    assert.deepEqual(
      [nothing.status, nothing.stdout, nothing.stderr],
      [0, 'Nothing to recover; current version 1.0.0.\n', ''],
    );
    const fresh = join(dir, 'fresh');
    const state = join(dir, 'fresh-state');
    await makeState(state);
    const keyFile = join(dir, 'keys', 'trust.pem');
    await put(keyFile, publicPem(pair));
    const installed = node(
      updateCli,
      '--install',
      fresh,
      '--release',
      await releaseOf('2.0.0'),
      '--state',
      state,
      '--trust-key',
      keyFile,
    );
    assert.deepEqual(
      [installed.status, installed.stdout, installed.stderr],
      [0, 'Installed 2.0.0\n', ''],
    );
    assert.equal((await inspectInstall(fresh)).complete, true);
  }));

test('release notes: optional signed text shown by the update notice', () =>
  withTemp(async (dir) => {
    const pair = keys();
    const sign = async (name, notes) => {
      const pkg = join(dir, `package-${name}`);
      await makePackage(pkg, '1.1.0');
      const release = join(dir, `release-${name}`);
      const manifest = await createRelease({
        packageDir: pkg,
        releaseDir: release,
        privateKey: pair.privateKey,
        ...(notes === undefined ? {} : { notes }),
      });
      return { release, manifest };
    };
    const withNotes = await sign('notes', 'Corrige el filtro.\nNuevo resumen.');
    assert.equal(withNotes.manifest.notes, 'Corrige el filtro.\nNuevo resumen.');
    const { readRelease, loadPublicKey } = await import('./release.mjs');
    const key = loadPublicKey(publicPem(pair));
    assert.equal(
      (await readRelease(withNotes.release, key)).manifest.notes,
      'Corrige el filtro.\nNuevo resumen.',
    );
    const without = await sign('plain');
    assert.equal('notes' in without.manifest, false);
    for (const [name, notes] of [
      ['blank', '  '],
      ['long', 'x'.repeat(4001)],
      ['object', { text: 'x' }],
    ])
      await assert.rejects(
        sign(name, notes),
        /^Error: Release notes must be non-empty text of at most 4000 characters$/,
      );
    // CLI: --notes is signed into the manifest.
    const pkg = join(dir, 'package-cli');
    await makePackage(pkg, '1.2.0');
    const signerFile = join(dir, 'keys', 'synthetic-signer.txt');
    await put(signerFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const out = join(dir, 'release-cli');
    const cli = node(
      releaseCli,
      '--package',
      pkg,
      '--out',
      out,
      '--key',
      signerFile,
      '--notes',
      'Nota.',
    );
    assert.deepEqual([cli.status, cli.stderr], [0, '']);
    assert.equal((await readRelease(out, key)).manifest.notes, 'Nota.');
  }));

test('rule 6: a state folder given as a link or junction is refused before anything is written', () =>
  withTemp(async (dir) => {
    const { pair, releaseOf } = await fixture(dir);
    const release = await releaseOf('1.0.0');
    // The original data folder; the link would have recorded it and migrated it in place.
    const real = join(dir, 'real-state');
    await makeState(real);
    const before = await snapshot(real);
    const existing = join(dir, 'install-existing');
    await put(join(existing, 'synthetic-note.txt'), 'left by an earlier attempt\n');
    const existingBefore = await snapshot(existing);
    for (const type of ['dir', 'junction']) {
      const link = join(dir, `linked-state-${type}`);
      await symlink(real, link, type);
      for (const given of [link, `${link}/`]) {
        const root = join(dir, `install-${type}`);
        await assert.rejects(
          install({ root, release, stateDir: given, trustKey: publicPem(pair) }),
          refused(
            /^The state folder .* is a link or junction: pass the real folder of the copy, never a link to it$/,
          ),
        );
        assert.equal(await lstat(root).catch((e) => e.code), 'ENOENT', 'no install root');
        await assert.rejects(
          install({ root: existing, release, stateDir: given, trustKey: publicPem(pair) }),
          (e) => e.code === 'REFUSED' && e.message.includes(given),
        );
        assert.deepEqual(await snapshot(existing), existingBefore, 'the install root is unchanged');
        assert.deepEqual(await snapshot(real), before, 'the link target is unchanged');
        assert.deepEqual(await siblings(real), [], 'no copy beside the original');
      }
    }
    // Preserved: the real folder itself still installs and is recorded as given.
    const root = join(dir, 'install-real');
    assert.deepEqual(await install({ root, release, stateDir: real, trustKey: publicPem(pair) }), {
      version: '1.0.0',
    });
    assert.equal(JSON.parse(await readFile(join(root, 'install.json'), 'utf8')).stateDir, real);
    assert.equal((await readCurrent(root)).version, '1.0.0');
  }));

test('rule 6: a state folder that became a link, or holds one, is refused before any copy', () =>
  withTemp(async (dir) => {
    for (const shape of ['replaced by a link', 'link inside']) {
      const work = join(dir, shape.replace(/ /g, '-'));
      const { root, state, releaseOf } = await fixture(work);
      if (shape === 'replaced by a link') {
        await rename(state, join(work, 'moved-state'));
        await symlink(join(work, 'moved-state'), state, 'dir');
      } else await symlink(join(work, 'outside'), join(state, 'uploads', 'elsewhere'), 'dir');
      const release = await releaseOf('1.1.0');
      const before = await snapshot(work);
      const calls = [];
      await assert.rejects(
        update({
          root,
          release,
          migrate: async () => calls.push('migrate'),
          ready: noop,
        }),
        refused(
          shape === 'replaced by a link'
            ? /^The state folder .* is a link; record the real folder instead$/
            : /^The state folder holds a link or special file \(uploads\/elsewhere\); it cannot be copied safely$/,
        ),
      );
      assert.deepEqual(calls, [], shape);
      const after = await snapshot(work);
      delete after['install/update.log'];
      delete before['install/update.log'];
      assert.deepEqual(after, before, shape);
    }
  }));

test('rule 6: an update without room for the pre-update copy and one restore is refused before any change', () =>
  withTemp(async (dir) => {
    const { root, state, releaseOf } = await fixture(dir);
    const before = await snapshot(state);
    const pointer = await readFile(join(root, 'current.json'));
    const asked = [];
    const calls = [];
    await assert.rejects(
      update({
        root,
        release: await releaseOf('1.1.0'),
        migrate: async () => calls.push('migrate'),
        ready: noop,
        statfs: async (path) => {
          asked.push(path);
          return { bavail: 2, bsize: 4096 };
        },
      }),
      refused(
        /^Not enough free disk beside the state folder for the pre-update copy and one restore: \d+ bytes needed, 8192 free$/,
      ),
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(asked, [dirname(state)]);
    assert.deepEqual(await snapshot(state), before);
    assert.deepEqual(await siblings(state), []);
    assert.deepEqual(await readdir(join(root, 'versions')), ['1.0.0']);
    assert.deepEqual(await readFile(join(root, 'current.json')), pointer);
    const roomy = await update({
      root,
      release: await releaseOf('1.1.0'),
      migrate: noop,
      ready: noop,
      statfs: async () => ({ bavail: 1 << 30, bsize: 4096 }),
    });
    assert.equal(roomy.to, '1.1.0');
  }));

test('a lock left by a crashed update is taken over when its pid belongs to another program', () =>
  withTemp(async (dir) => {
    const { root } = await fixture(dir);
    await writeFile(
      join(root, 'update.lock'),
      JSON.stringify({ pid: process.ppid, time: '2026-01-01T00:00:00.000Z' }),
    );
    assert.equal((await recover({ root })).version, '1.0.0');
    // An empty or unreadable lock is someone writing it right now, unless it is old.
    await writeFile(join(root, 'update.lock'), '');
    await assert.rejects(recover({ root }), (error) => error.code === 'BUSY');
    const old = new Date('2026-01-01T00:00:00.000Z');
    await utimes(join(root, 'update.lock'), old, old);
    assert.equal((await recover({ root })).version, '1.0.0');
    assert.deepEqual((await readdir(root)).sort(), [
      'current.json',
      'install.json',
      'update.log',
      'versions',
    ]);
  }));

test('a running update keeps its lock: another run is BUSY until it ends', () =>
  withTemp(async (dir) => {
    const { root, releaseOf } = await fixture(dir);
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    let entered;
    const migrating = new Promise((resolve) => (entered = resolve));
    const running = update({
      root,
      release: await releaseOf('1.1.0'),
      migrate: async () => {
        entered();
        await gate;
      },
      ready: noop,
    });
    await migrating;
    await assert.rejects(recover({ root }), (error) => error.code === 'BUSY');
    // A fresh lock of a live process in the old format is respected too.
    open();
    assert.equal((await running).to, '1.1.0');
    await writeFile(
      join(root, 'update.lock'),
      JSON.stringify({ pid: process.ppid, time: new Date().toISOString() }),
    );
    await assert.rejects(recover({ root }), (error) => error.code === 'BUSY');
  }));

test('rule 1: a signed release whose metadata.json names another version is refused', () =>
  withTemp(async (dir) => {
    const { root, pair, releaseOf } = await fixture(dir);
    const release = await releaseOf('1.1.0');
    const metaPath = join(release, 'package', 'metadata.json');
    const metadata = JSON.parse(await readFile(metaPath, 'utf8'));
    await writeFile(metaPath, `${JSON.stringify({ ...metadata, version: '1.2.0' }, null, 2)}\n`);
    const manifest = JSON.parse(await readFile(join(release, 'release.json'), 'utf8'));
    manifest.files['metadata.json'] = createHash('sha256')
      .update(await readFile(metaPath))
      .digest('hex');
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(release, 'release.json'), bytes);
    await writeFile(
      join(release, 'release.sig'),
      `${sign(null, bytes, pair.privateKey).toString('base64')}\n`,
    );
    const reason = /^metadata\.json says 1\.2\.0 but the signed release is 1\.1\.0$/;
    const found = await findUpdate({ root, source: release });
    assert.equal(found.available, null);
    assert.match(found.skipped[0]?.reason ?? '', reason);
    await assert.rejects(update({ root, release, migrate: noop, ready: noop }), refused(reason));
    assert.deepEqual(await readdir(join(root, 'versions')), ['1.0.0']);
  }));

test('rule 7: an adoption whose release is refused records nothing', () =>
  withTemp(async (dir) => {
    const pair = keys();
    const legacy = join(dir, 'old-install');
    const state = join(dir, 'state');
    await makePackage(legacy, '0.9.0');
    await makeState(state);
    const release = join(dir, 'release-1.0.0');
    await makePackage(join(dir, 'pkg-1.0.0'), '1.0.0');
    await createRelease({
      packageDir: join(dir, 'pkg-1.0.0'),
      releaseDir: release,
      privateKey: keys().privateKey,
    });
    const root = join(dir, 'install');
    await assert.rejects(
      update({
        root,
        release,
        adopt: { dir: legacy, stateDir: state },
        trustKey: publicPem(pair),
        migrate: noop,
        ready: noop,
      }),
      refused(/signature does not match/),
    );
    assert.equal(await readCurrent(root), null);
    const names = await readdir(root);
    assert.equal(names.includes('install.json'), false, String(names));
    assert.equal(names.includes('current.json'), false, String(names));
  }));

test(
  'a failure while staging (a full disk) is logged and leaves the install unchanged',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  () =>
    withTemp(async (dir) => {
      const { root, releaseOf } = await fixture(dir);
      const release = await releaseOf('1.1.0');
      await chmod(join(root, 'versions'), 0o500);
      try {
        await assert.rejects(
          update({ root, release, migrate: noop, ready: noop }),
          (error) => error.code === 'EACCES',
        );
      } finally {
        await chmod(join(root, 'versions'), 0o700);
      }
      const last = (await logLines(root)).at(-1);
      assert.deepEqual([last.event, last.step, last.code], ['failed', 'stage', 'EACCES']);
      assert.match(last.reason, /EACCES/);
      assert.deepEqual(await readdir(join(root, 'versions')), ['1.0.0']);
      assert.equal((await readCurrent(root)).version, '1.0.0');
    }),
);

test('rule 6: a state folder swapped for a link just before the copy rolls back cleanly', () =>
  withTemp(async (dir) => {
    const { root, state, releaseOf } = await fixture(dir);
    const before = await snapshot(state);
    const moved = join(dir, 'moved-state');
    await assert.rejects(
      update({
        root,
        release: await releaseOf('1.1.0'),
        migrate: noop,
        ready: noop,
        onStep: async (step) => {
          if (step !== 'installed') return;
          await rename(state, moved);
          await symlink(moved, state, 'dir');
        },
      }),
      rolledBack(/failed at state copy .*is a link/),
    );
    assert.equal((await readCurrent(root)).version, '1.0.0');
    assert.deepEqual(await snapshot(moved), before);
    assert.equal((await readdir(root)).includes('update-journal.json'), false);
    assert.equal((await recover({ root })).recovered, false);
  }));

test("way out of a halt: after restoring one's own backup, --accept-restored-state clears the update", () =>
  withTemp(async (dir) => {
    const { root, state, releaseOf } = await fixture(dir);
    const backup = join(dir, 'own-backup');
    await cp(state, backup, { recursive: true, preserveTimestamps: true });
    const wreck = async ({ stateDir }) => {
      await writeFile(join(stateDir, 'pglite/PG_VERSION'), 'half migrated\n');
      for (const name of await readdir(dirname(stateDir)))
        if (name.includes('.pre-update-'))
          await rm(join(dirname(stateDir), name), { recursive: true });
      throw new Error('synthetic migration failure');
    };
    await assert.rejects(
      update({ root, release: await releaseOf('1.1.0'), migrate: wreck, ready: noop }),
      (error) => error.code === 'ROLLBACK_INCOMPLETE',
    );
    const journal = join(root, 'update-journal.json');
    const pending = await readFile(journal, 'utf8');
    const accept = () => node(updateCli, '--install', root, '--recover', '--accept-restored-state');
    assert.equal(node(updateCli, '--install', root, '--recover').status, 3, 'still halted');

    // Refused while the state folder is missing or empty; nothing changes.
    await rename(state, join(dir, 'half-migrated-aside'));
    const missing = accept();
    assert.deepEqual([missing.status, missing.stdout], [1, '']);
    assert.match(
      missing.stderr,
      /^Error: The state folder .+ does not exist: restore your backup there first\n$/,
    );
    await mkdir(state);
    const empty = accept();
    assert.deepEqual([empty.status, empty.stdout], [1, '']);
    assert.match(
      empty.stderr,
      /^Error: The state folder .+ is empty: restore your backup there first\n$/,
    );
    assert.equal(await readFile(journal, 'utf8'), pending);

    // The person put their own backup back: accepted as it is, never copied over or moved.
    await rm(state, { recursive: true });
    await cp(backup, state, { recursive: true, preserveTimestamps: true });
    const restored = await snapshot(state);
    const besides = await siblings(state);
    const done = accept();
    assert.deepEqual(
      [done.status, done.stdout, done.stderr],
      [0, 'Accepted the restored state folder; current version 1.0.0.\n', ''],
    );
    assert.deepEqual(await snapshot(state), restored);
    assert.deepEqual(await siblings(state), besides);
    assert.equal((await readdir(root)).includes('update-journal.json'), false);
    assert.equal((await readCurrent(root)).version, '1.0.0');
    const last = (await logLines(root)).at(-1);
    assert.deepEqual(
      [last.event, last.from, last.to, last.stateDir],
      ['restored-state-accepted', '1.1.0', '1.0.0', state],
    );
    assert.deepEqual(
      [accept().stdout, node(updateCli, '--install', root, '--recover').stdout],
      [
        'Nothing to recover; current version 1.0.0.\n',
        'Nothing to recover; current version 1.0.0.\n',
      ],
    );
    const alone = node(updateCli, '--install', root, '--accept-restored-state');
    assert.deepEqual(
      [alone.status, alone.stderr],
      [1, 'Error: --accept-restored-state goes with --recover\n'],
    );
  }));

test('CLI: a first install can trust the key that signed the release, and prints its fingerprint', () =>
  withTemp(async (dir) => {
    const { pair, releaseOf } = await fixture(dir);
    const fresh = join(dir, 'fresh');
    const state = join(dir, 'fresh-state');
    await makeState(state);
    const release = await releaseOf('2.0.0');
    const fingerprint = createHash('sha256')
      .update(pair.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    const args = ['--install', fresh, '--release', release, '--state', state];
    const both = node(updateCli, ...args, '--trust-release-key', '--trust-key', release);
    assert.deepEqual(
      [both.status, both.stdout, both.stderr],
      [1, '', 'Error: Use either --trust-key or --trust-release-key\n'],
    );
    const done = node(updateCli, ...args, '--trust-release-key');
    assert.deepEqual(
      [done.status, done.stdout, done.stderr],
      [
        0,
        `Trusting the update key that signed this release (SHA-256 ${fingerprint}).\nInstalled 2.0.0\n`,
        '',
      ],
    );
    assert.equal((await inspectInstall(fresh)).complete, true);
    const later = node(
      updateCli,
      '--install',
      fresh,
      '--release',
      await releaseOf('2.1.0'),
      '--trust-release-key',
    );
    assert.deepEqual(
      [later.status, later.stderr],
      [1, 'Error: --trust-release-key is only for a first install\n'],
    );
    assert.equal((await readCurrent(fresh)).version, '2.0.0');
  }));

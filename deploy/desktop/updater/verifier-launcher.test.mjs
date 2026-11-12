// Kept from the second independent verification (desktop-updates L7): halt after an incomplete
// rollback (defect 1) and the way out of it, damaged or swapped releases (defect 4) and the
// cleaned environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { LAUNCHER_ENV, freePort, managedEnv } from './boot.mjs';
import { CHANNEL, launch } from './launcher.mjs';
import {
  findUpdate,
  firstStart,
  inspectInstall,
  install,
  readCurrent,
  update,
} from './updater.mjs';
import {
  makeState,
  newPair,
  publicPem,
  put,
  releases,
  siblings,
  snapshot,
  withTemp,
} from './verifier-helpers.mjs';

const launcherCli = join(dirname(fileURLToPath(import.meta.url)), 'launcher.mjs');
const updateCli = join(dirname(fileURLToPath(import.meta.url)), 'update.mjs');
const APP = (version) => `import { createServer } from 'node:http';
const server = createServer((req, res) => {
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html>'); }
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health/ready') return res.end('{"status":"ready"}');
  if (req.url === '/env')
    return res.end(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase().startsWith('SIPGES_')).sort())));
  if (req.url === '/about') return res.end(JSON.stringify({ version: '${version}', pid: process.pid }));
  res.statusCode = 404;
  res.end('{}');
});
server.listen(Number(process.env.SIPGES_PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;
async function appPackage(dir, version, start) {
  const metadata = {
    version,
    platform: process.platform,
    arch: process.arch,
    node: '>=24',
    entry: 'start.mjs',
  };
  await put(join(dir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  await put(join(dir, 'start.mjs'), start ?? APP(version));
  await put(join(dir, 'web/index.html'), `<!doctype html><title>SIPGES ${version}</title>\n`);
  await put(join(dir, 'api/src/main.js'), `export const version = '${version}';\n`);
  await put(
    join(dir, 'api/node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js'),
    'export {};\n',
  );
  await mkdir(join(dir, 'references'), { recursive: true });
  await symlink('.pnpm/dep@1.0.0/node_modules/dep', join(dir, 'api/node_modules/dep'), 'dir');
}
async function fixture(dir) {
  const pair = newPair();
  const root = join(dir, 'install');
  const state = join(dir, 'data', 'state');
  const source = join(dir, 'releases');
  await mkdir(source);
  const rel = releases(dir, pair, { make: appPackage, parent: source });
  await install({
    root,
    release: await rel('1.0.0', { parent: dir }),
    stateDir: state,
    trustKey: publicPem(pair),
  });
  // An install whose first start already happened on a fresh folder, then gathered data: these
  // tests are about updates (the first start over existing data is first-start.test.mjs).
  await firstStart({ root, migrate: async () => {} });
  await makeState(state);
  return { root, state, source, pair, rel };
}
async function answers(port) {
  for (let i = 0; i < 200; i += 1) {
    try {
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/about`);
      if (res.ok) return await res.json();
    } catch {
      /* not yet */
    }
    await sleep(25);
  }
  throw new Error('the synthetic app never answered');
}
async function started(options) {
  const port = await freePort();
  const lines = [];
  const running = await launch({
    port,
    pollMs: 20,
    log: (event, fields) => lines.push({ event, ...fields }),
    migrate: async () => {},
    ready: async () => {},
    ...options,
  });
  return { ...running, port, lines, about: () => answers(port) };
}
const until = async (lines, event, ms = 4000) => {
  for (let waited = 0; waited < ms; waited += 20) {
    const line = lines.find((l) => l.event === event);
    if (line) return line;
    await sleep(20);
  }
  throw new Error(`no ${event} line: ${JSON.stringify(lines.map((l) => l.event))}`);
};
const status = async (root) =>
  JSON.parse(await readFile(join(root, CHANNEL, 'status.json'), 'utf8'));
const request = (root, version) =>
  writeFile(join(root, CHANNEL, 'request.json'), JSON.stringify({ format: 1, version }));
const quiet = (rel) => rel === 'update.log' || rel.startsWith(CHANNEL) || rel === 'update-boot.log';
const closed = (port) => assert.rejects(globalThis.fetch(`http://127.0.0.1:${port}/about`));
const cliOnce = (root, port) => {
  const cli = spawnSync(process.execPath, [launcherCli, '--install', root, '--port', `${port}`], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return {
    ...cli,
    events: cli.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  };
};
function cliStart(args) {
  const run = spawn(process.execPath, [launcherCli, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = {
    run,
    stdout: '',
    stderr: '',
    events: () =>
      out.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
  };
  run.stdout.on('data', (d) => (out.stdout += d));
  run.stderr.on('data', (d) => (out.stderr += d));
  out.exit = once(run, 'exit').then(([code]) => code);
  return out;
}
const NOTICE =
  /^SIPGES no se inició: una actualización falló y sus datos no se pudieron restaurar\. No borre nada\. Restaure la copia de seguridad .+ o contacte con soporte\.\n/;

const damage = {
  'a same-size change in one file': [
    async (p) =>
      writeFile(join(p, 'web/index.html'), '<!doctype html><title>SIPGES 9.9.9</title>\n'),
    /does not match the signed release: web\/index\.html/,
  ],
  'an unlisted file': [async (p) => writeFile(join(p, 'extra.js'), 'x'), /unlisted extra\.js/],
  'a missing file': [async (p) => rm(join(p, 'api/src/main.js')), /missing api\/src\/main\.js/],
  'an unlisted empty folder': [async (p) => mkdir(join(p, 'extra-dir')), /unlisted extra-dir/],
  'a missing empty folder': [async (p) => rmdir(join(p, 'references')), /missing references/],
  'a link replaced by a real folder': [
    async (p) => {
      await rm(join(p, 'api/node_modules/dep'));
      await cp(
        join(p, 'api/node_modules/.pnpm/dep@1.0.0/node_modules/dep'),
        join(p, 'api/node_modules/dep'),
        { recursive: true },
      );
    },
    /unlisted|missing/,
  ],
  'a file replaced by a link to an identical file': [
    async (p, dir) => {
      await cp(join(p, 'api/src/main.js'), join(dir, 'same.js'));
      await rm(join(p, 'api/src/main.js'));
      await symlink(join(dir, 'same.js'), join(p, 'api/src/main.js'));
    },
    /unlisted|missing/,
  ],
  'a package folder that is a link to an identical package': [
    async (p, dir) => {
      await rename(p, join(dir, 'moved'));
      await symlink(join(dir, 'moved'), p, 'dir');
    },
    /not a folder/,
  ],
  'no package folder': [async (p) => rm(p, { recursive: true }), /no package folder/],
};
for (const [name, [make, reason]] of Object.entries(damage))
  test(`D4: a newer release with ${name} is never offered; the older intact one is`, () =>
    withTemp(async (dir) => {
      const { root, source, rel } = await fixture(dir);
      await rel('1.1.0');
      const bad = await rel('1.2.0');
      await make(join(bad, 'package'), dir);
      const before = [await snapshot(root), await snapshot(source)];
      const found = await findUpdate({ root, source });
      assert.equal(found.available?.version, '1.1.0');
      assert.equal(found.skipped.length, 1);
      assert.equal(found.skipped[0].release, bad);
      assert.match(found.skipped[0].reason, reason);
      assert.deepEqual([await snapshot(root), await snapshot(source)], before);
    }));

test('D4 note: a source link that points elsewhere is offered, and the install gets the signed link', () =>
  withTemp(async (dir) => {
    const { root, source, rel } = await fixture(dir);
    const release = await rel('1.1.0');
    await rm(join(release, 'package/api/node_modules/dep'));
    await symlink('.pnpm', join(release, 'package/api/node_modules/dep'), 'dir');
    assert.equal((await findUpdate({ root, source })).available?.version, '1.1.0');
    await update({ root, release, migrate: async () => {}, ready: async () => {} });
    assert.equal(
      await readlink(join(root, 'versions/1.1.0/api/node_modules/dep')),
      '.pnpm/dep@1.0.0/node_modules/dep',
    );
    assert.deepEqual(await inspectInstall(root).then((i) => [i.version, i.complete]), [
      '1.1.0',
      true,
    ]);
  }));

const swaps = {
  'one file changed': async (release) =>
    writeFile(
      join(release, 'package/web/index.html'),
      '<!doctype html><title>SIPGES 6.6.6</title>\n',
    ),
  'a file added': async (release) => writeFile(join(release, 'package/added.js'), 'x'),
  'the folder removed': async (release) => rm(release, { recursive: true }),
  'a signed newer version put in its place': async (release, fx) => {
    await rm(release, { recursive: true });
    await fx.rel('1.2.0', { name: basename(release) });
  },
  'a release of another signer put in its place': async (release, fx) => {
    await rm(release, { recursive: true });
    await fx.rel('1.1.0', { name: basename(release), signer: newPair() });
  },
};
for (const [name, swap] of Object.entries(swaps))
  test(`D4: release folder swapped between the check and the click (${name}): nothing installed, SIPGES keeps running`, () =>
    withTemp(async (dir) => {
      const fx = await fixture(dir);
      const { root, state, source, rel } = fx;
      const release = await rel('1.1.0');
      const run = await started({ root, source });
      try {
        await run.checked;
        const first = await run.about();
        assert.equal((await status(root)).available.version, '1.1.0');
        const before = [await snapshot(root, quiet), await snapshot(dirname(state))];
        await swap(release, fx);
        await request(root, '1.1.0');
        const refused = await until(run.lines, 'update_request_refused');
        assert.equal(refused.version, '1.1.0');
        const again = await run.about();
        assert.deepEqual(again, first, 'the server was restarted');
        assert.deepEqual(
          run.lines
            .filter((l) => ['started', 'update_started'].includes(l.event))
            .map((l) => l.event),
          ['started'],
        );
        assert.equal((await status(root)).available, null);
        assert.deepEqual([await snapshot(root, quiet), await snapshot(dirname(state))], before);
        assert.equal((await readCurrent(root)).version, '1.0.0');
      } finally {
        await run.stop();
      }
    }));

test('D4: a release changed after the re-check and before the copy is refused by the update itself', () =>
  withTemp(async (dir) => {
    const { root, state, source, rel } = await fixture(dir);
    const release = await rel('1.1.0');
    let calls = 0;
    const find = async (args) => {
      const result = await findUpdate(args);
      calls += 1;
      if (calls === 2)
        await writeFile(
          join(release, 'package/web/index.html'),
          '<!doctype html><title>SIPGES 6.6.6</title>\n',
        );
      return result;
    };
    const run = await started({ root, source, find });
    try {
      await run.checked;
      await run.about();
      const before = await snapshot(dirname(state));
      await request(root, '1.1.0');
      const failed = await until(run.lines, 'update_failed');
      assert.equal(failed.code, 'REFUSED');
      assert.match(failed.reason, /does not match the signed release: web\/index\.html/);
      const starts = () => run.lines.filter((l) => l.event === 'started').length;
      for (let i = 0; i < 200 && starts() < 2; i += 1) await sleep(20);
      assert.equal(starts(), 2, 'the previous version was started again');
      assert.equal((await run.about()).version, '1.0.0');
      assert.deepEqual(await snapshot(dirname(state)), before);
      assert.deepEqual(await readdir(join(root, 'versions')), ['1.0.0']);
    } finally {
      await run.stop();
    }
  }));

test(
  'D1: a rollback that cannot finish halts with code 3; later starts stay halted until the cause is fixed, then recover',
  { timeout: 60_000 },
  () =>
    withTemp(async (dir) => {
      const { root, state, source, rel } = await fixture(dir);
      await rel('1.1.0');
      const run = await started({
        root,
        source,
        migrate: async ({ stateDir }) => {
          await writeFile(join(stateDir, 'pglite/PG_VERSION'), 'half migrated\n');
          await chmod(dirname(stateDir), 0o555); // the restore cannot write beside the state folder
          throw new Error('synthetic migration failure');
        },
      });
      let original;
      try {
        await run.checked;
        await run.about();
        original = await snapshot(state);
        await request(root, '1.1.0');
        assert.equal(
          await Promise.race([
            run.done,
            sleep(5000, undefined, { ref: false }).then(() => 'still running'),
          ]),
          3,
        );
        const failed = run.lines.find((l) => l.event === 'update_failed');
        assert.equal(failed.code, 'ROLLBACK_INCOMPLETE');
        assert.match(`${failed.action}\n`, NOTICE);
        assert.equal(run.lines.filter((l) => l.event === 'started').length, 1);
        assert.match(`${run.halted()}\n`, NOTICE);
        await closed(run.port);
      } finally {
        await run.stop();
      }
      const halted = await snapshot(state);
      assert.notDeepEqual(halted, original);
      for (const attempt of [1, 2]) {
        const port = await freePort();
        const cli = cliOnce(root, port);
        assert.equal(cli.status, 3, `attempt ${attempt}: ${cli.stderr}`);
        assert.deepEqual(
          cli.events.map((e) => [e.event, e.code]),
          [['start_refused', 'ROLLBACK_INCOMPLETE']],
        );
        assert.match(cli.stderr, NOTICE);
        await closed(port);
        assert.deepEqual(await snapshot(state), halted, 'a halted start changed the state folder');
        assert.equal((await readdir(root)).includes('update-journal.json'), true);
      }
      await chmod(dirname(state), 0o755); // the cause is fixed
      const port = await freePort();
      const cli = cliStart(['--install', root, '--port', `${port}`]);
      try {
        assert.equal((await answers(port)).version, '1.0.0');
        assert.deepEqual(
          cli.events().map((e) => e.event),
          ['update_recovered', 'started'],
        );
        assert.deepEqual(await snapshot(state), original);
        assert.equal((await readdir(root)).includes('update-journal.json'), false);
      } finally {
        cli.run.kill('SIGTERM');
      }
      assert.equal(await cli.exit, 0);
    }),
);

const WRECK = `import { readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
const state = dirname(process.env.SIPGES_PGLITE_DIR);
for (const name of readdirSync(dirname(state)))
  if (name.includes('.pre-update-')) rmSync(join(dirname(state), name), { recursive: true });
process.exit(1);
`;
test(
  'D1 end to end: the launcher CLI halts with code 3 and the notice; the person restores a backup and accepts it',
  { timeout: 90_000 },
  () =>
    withTemp(async (dir) => {
      const { root, state, source, rel } = await fixture(dir);
      await rel('1.1.0', { start: WRECK });
      const backup = join(dir, 'own-backup');
      const port = await freePort();
      const cli = cliStart(['--install', root, '--releases', source, '--port', `${port}`]);
      try {
        await answers(port);
        while (!cli.events().some((e) => e.event === 'update_check')) await sleep(50);
        assert.equal(cli.events().find((e) => e.event === 'update_check').available, '1.1.0');
        await cp(state, backup, { recursive: true, preserveTimestamps: true });
        await request(root, '1.1.0');
        assert.equal(
          await Promise.race([
            cli.exit,
            sleep(60_000, undefined, { ref: false }).then(() => 'still running'),
          ]),
          3,
        );
      } finally {
        cli.run.kill('SIGKILL');
      }
      const events = cli.events();
      assert.deepEqual(
        events.map((e) => e.event),
        ['started', 'update_check', 'update_started', 'update_failed'],
      );
      assert.equal(events.at(-1).code, 'ROLLBACK_INCOMPLETE');
      assert.match(cli.stderr, NOTICE);
      await closed(port);

      // Next start: still halted.
      const second = cliOnce(root, await freePort());
      assert.equal(second.status, 3);
      assert.match(second.stderr, NOTICE);

      // The person follows the notice with their own backup (the named copy is gone).
      const failedAside = (await siblings(state)).filter((n) => n.includes('.failed-'));
      await rm(state, { recursive: true, force: true });
      await cp(backup, state, { recursive: true, preserveTimestamps: true });
      const third = cliOnce(root, await freePort());
      assert.equal(third.status, 3, 'a plain start stays halted: the named copy is gone');
      assert.equal(failedAside.length, 0);

      // The way out: accept the restored folder, then SIPGES starts on it, unchanged.
      const restored = await snapshot(state);
      const accepted = spawnSync(
        process.execPath,
        [updateCli, '--install', root, '--recover', '--accept-restored-state'],
        { encoding: 'utf8' },
      );
      assert.deepEqual(
        [accepted.status, accepted.stdout, accepted.stderr],
        [0, 'Accepted the restored state folder; current version 1.0.0.\n', ''],
      );
      const port2 = await freePort();
      const fourth = cliStart(['--install', root, '--port', `${port2}`]);
      try {
        assert.equal((await answers(port2)).version, '1.0.0');
        assert.deepEqual(
          fourth.events().map((e) => e.event),
          ['started'],
        );
        assert.deepEqual(await snapshot(state), restored);
      } finally {
        fourth.run.kill('SIGTERM');
      }
      assert.equal(await fourth.exit, 0);
    }),
);

test("env: no inherited SIPGES_* reaches the server; SIPGES_REFERENCE_DIR is the version's own", () =>
  withTemp(async (dir) => {
    const { root, state } = await fixture(dir);
    const base = {
      PATH: process.env.PATH,
      OTHER: 'kept',
      SIPGES_REFERENCE_DIR: '/synthetic/reference',
      SIPGES_REQUIRE_MFA: '0',
      SIPGES_DATABASE_URL: 'synthetic',
      SIPGES_PORT: '1',
      sipges_lower: 'x',
    };
    const env = await managedEnv({
      versionDir: join(root, 'versions/1.0.0'),
      stateDir: state,
      port: 4321,
      base,
    });
    assert.deepEqual(
      Object.keys(env)
        .filter((k) => k.toUpperCase().startsWith('SIPGES_'))
        .sort(),
      LAUNCHER_ENV.filter((k) => k !== 'SIPGES_DESKTOP_UPDATE_DIR'),
    );
    assert.equal(env.SIPGES_REFERENCE_DIR, join(root, 'versions/1.0.0/references'));
    assert.equal(env.SIPGES_PORT, '4321');
    assert.equal(env.OTHER, 'kept');
    const run = await started({ root, baseEnv: base });
    try {
      await run.about();
      const seen = await (await globalThis.fetch(`http://127.0.0.1:${run.port}/env`)).json();
      assert.equal(seen.SIPGES_REFERENCE_DIR, join(root, 'versions/1.0.0/references'));
      assert.equal('SIPGES_REQUIRE_MFA' in seen, false);
      assert.equal('SIPGES_DATABASE_URL' in seen, false);
      assert.equal(seen.SIPGES_DESKTOP_UPDATE_DIR, join(root, CHANNEL));
      assert.deepEqual(Object.keys(seen), [...LAUNCHER_ENV]);
    } finally {
      await run.stop();
    }
  }));
